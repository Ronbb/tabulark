//! Thin, publish-disabled WebAssembly wrapper for the Arrow IPC adapter.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::Serialize;
use tabulark::arrow::{
    ArrowFileReadOperation, ArrowIpcOpenOperation, ArrowIpcOptions, ArrowIpcRuntime,
    ArrowReadStart, ArrowRuntimeConfig, ArrowSourceHandle, ArrowTableHandle, ReadBytesAction,
};
use tabulark::model::{RangeRequest, TableMetadata, TypedTableBatch};
use tabulark::protocol::{
    ADAPTER_API_VERSION, ARROW_IPC_ADAPTER_ID, BATCH_LAYOUT_VERSION, PROTOCOL_VERSION,
};
use tabulark::{ErrorCode, TabularkError};
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

struct PendingOpen {
    operation: ArrowIpcOpenOperation,
    table_name: String,
    source: Option<ArrowSourceHandle>,
}

struct PendingRead {
    operation: ArrowFileReadOperation,
    source: ArrowSourceHandle,
    table: ArrowTableHandle,
}

enum PendingOperation {
    Open(Box<PendingOpen>),
    Read(Box<PendingRead>),
}

struct State {
    runtime: ArrowIpcRuntime,
    memory_budget_bytes: usize,
    next_operation: u32,
    operations: HashMap<u32, PendingOperation>,
    table_sources: HashMap<ArrowTableHandle, ArrowSourceHandle>,
}

impl State {
    fn allocate_operation(&mut self) -> std::result::Result<u32, JsValue> {
        let operation = self.next_operation;
        self.next_operation = self.next_operation.checked_add(1).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow operation handle space exhausted",
            ))
        })?;
        Ok(operation)
    }

    fn close_pending_open(&mut self, pending: &PendingOpen) {
        let Some(source) = pending.source else {
            return;
        };
        self.table_sources.retain(|_, owner| *owner != source);
        self.runtime.close_source(source);
    }

    fn cancel_pending(&mut self, pending: PendingOperation) {
        if let PendingOperation::Open(open) = pending {
            self.close_pending_open(&open);
        }
    }
}

/// Dedicated Arrow IPC runtime artifact implementing adapter ABI v1.
#[wasm_bindgen]
pub struct WasmArrowRuntime {
    state: RefCell<State>,
}

#[wasm_bindgen]
impl WasmArrowRuntime {
    /// Creates an empty Arrow adapter runtime.
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> std::result::Result<WasmArrowRuntime, JsValue> {
        let config = if config.is_null() || config.is_undefined() {
            ArrowRuntimeConfig::default()
        } else {
            from_js(config)?
        };
        let memory_budget_bytes = config.memory_budget_bytes;
        Ok(Self {
            state: RefCell::new(State {
                runtime: ArrowIpcRuntime::new(config).map_err(error_to_js)?,
                memory_budget_bytes,
                next_operation: 1,
                operations: HashMap::new(),
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

    /// Returns typed-buffer layout version one.
    #[wasm_bindgen(js_name = batchLayoutVersion)]
    pub fn batch_layout_version(&self) -> u32 {
        BATCH_LAYOUT_VERSION
    }

    /// Returns the frozen official adapter ID.
    #[wasm_bindgen(js_name = adapterId)]
    pub fn adapter_id(&self) -> String {
        ARROW_IPC_ADAPTER_ID.to_owned()
    }

    /// Begins an open without copying the full source into WebAssembly.
    ///
    /// IPC Files request only their trailer, footer, and record metadata here.
    /// IPC Streams request bounded sequential chunks.
    #[wasm_bindgen(js_name = beginOpen)]
    pub fn begin_open(
        &self,
        options: JsValue,
        source_length: f64,
    ) -> std::result::Result<JsValue, JsValue> {
        let source_length = safe_usize(source_length, "sourceLength")?;
        let options = if options.is_null() || options.is_undefined() {
            ArrowIpcOptions::default()
        } else {
            from_js(options)?
        };
        // Fail before the first ingress action when the Worker has supplied
        // limits that cannot fit the engine it just constructed.  Without
        // this check a Stream could spend its full sequential scan only to
        // fail while registering the completed source.
        let memory_budget_bytes = self.state.borrow().memory_budget_bytes;
        options
            .limits
            .validate_for_memory_budget(memory_budget_bytes)
            .map_err(error_to_js)?;
        let table_name = options.table_name.clone();
        let operation = ArrowIpcOpenOperation::new(source_length, options).map_err(error_to_js)?;
        let action = operation
            .next_action()
            .map_err(error_to_js)?
            .ok_or_else(|| {
                error_to_js(TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Arrow open operation produced no initial byte action",
                ))
            })?;
        let mut state = self.state.borrow_mut();
        let handle = state.allocate_operation()?;
        let result = operation_action(handle, action)?;
        state.operations.insert(
            handle,
            PendingOperation::Open(Box::new(PendingOpen {
                operation,
                table_name,
                source: None,
            })),
        );
        Ok(result)
    }

    /// Supplies exactly one requested source byte range and advances an open
    /// or File range-read operation.
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
                "Arrow operation handle is closed",
            ))
        })?;
        match pending {
            PendingOperation::Open(mut pending) => {
                match advance_open(
                    &mut state,
                    operation_handle,
                    absolute_offset,
                    owned,
                    eof,
                    &mut pending,
                ) {
                    Ok((result, true)) => Ok(result),
                    Ok((result, false)) => {
                        state
                            .operations
                            .insert(operation_handle, PendingOperation::Open(pending));
                        Ok(result)
                    }
                    Err(error) => {
                        state.close_pending_open(&pending);
                        Err(error)
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
                        let action = pending
                            .operation
                            .next_action()
                            .map_err(error_to_js)?
                            .ok_or_else(|| {
                                error_to_js(TabularkError::new(
                                    ErrorCode::RuntimeFailure,
                                    "Arrow read operation stopped without a batch",
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
        let source = ArrowSourceHandle::from_raw(source_handle);
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
        let result = (|| {
            let result = Object::new();
            set(
                &result,
                "tableHandle",
                JsValue::from_f64(f64::from(table.get())),
            )?;
            set(&result, "metadata", to_js(&metadata)?)?;
            Ok::<_, JsValue>(result)
        })();
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                state.runtime.close_table(table);
                return Err(error);
            }
        };
        state.table_sources.insert(table, source);
        Ok(result.into())
    }

    /// Returns the latest table metadata.
    pub fn metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let metadata = state
            .runtime
            .metadata(ArrowTableHandle::from_raw(table_handle))
            .map_err(error_to_js)?;
        to_js(metadata)
    }

    /// Starts a range read. Streams complete from retained decoded batches;
    /// Files request only dictionaries and intersecting record blocks.
    #[wasm_bindgen(js_name = beginRead)]
    pub fn begin_read(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let request: RangeRequest = from_js(request)?;
        let table = ArrowTableHandle::from_raw(table_handle);
        let mut state = self.state.borrow_mut();
        let source = *state.table_sources.get(&table).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Arrow table handle is closed",
            ))
        })?;
        match state
            .runtime
            .begin_read(table, request)
            .map_err(error_to_js)?
        {
            ArrowReadStart::Complete(batch) => complete_batch(&batch),
            ArrowReadStart::File(operation) => {
                let action = operation
                    .next_action()
                    .map_err(error_to_js)?
                    .ok_or_else(|| {
                        error_to_js(TabularkError::new(
                            ErrorCode::RuntimeFailure,
                            "Arrow File read produced no initial byte action",
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

    /// Cancels and releases a pending adapter operation.
    #[wasm_bindgen(js_name = cancelOperation)]
    pub fn cancel_operation(&self, operation_handle: u32) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(operation) = state.operations.remove(&operation_handle) else {
            return false;
        };
        state.cancel_pending(operation);
        true
    }

    /// Idempotently closes one table and its in-flight reads.
    #[wasm_bindgen(js_name = closeTable)]
    pub fn close_table(&self, table_handle: u32) -> bool {
        let table = ArrowTableHandle::from_raw(table_handle);
        let mut state = self.state.borrow_mut();
        state.table_sources.remove(&table);
        state.operations.retain(|_, operation| {
            !matches!(operation, PendingOperation::Read(read) if read.table == table)
        });
        state.runtime.close_table(table)
    }

    /// Idempotently closes one source, its tables, and all child reads.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        let source = ArrowSourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        state.operations.retain(|_, operation| {
            !matches!(operation, PendingOperation::Read(read) if read.source == source)
                && !matches!(operation, PendingOperation::Open(open) if open.source == Some(source))
        });
        state.table_sources.retain(|_, owner| *owner != source);
        state.runtime.close_source(source)
    }

    /// Releases all operations, tables, and sources.
    pub fn shutdown(&self) {
        let mut state = self.state.borrow_mut();
        state.operations.clear();
        state.table_sources.clear();
        state.runtime.shutdown();
    }
}

/// Advances an Arrow open operation and, once a Stream has decoded its schema,
/// publishes a stable source handle for its currently indexed prefix.
///
/// The boolean result is `true` only after EOF has produced exact metadata.
/// Callers retain incomplete operations so the Worker can continue them in the
/// background while tables read the published prefix.
fn advance_open(
    state: &mut State,
    operation_handle: u32,
    absolute_offset: u64,
    bytes: Vec<u8>,
    eof: bool,
    pending: &mut PendingOpen,
) -> std::result::Result<(JsValue, bool), JsValue> {
    let bytes_len = bytes.len();
    match pending
        .operation
        .feed_owned(absolute_offset, bytes, eof)
        .map_err(error_to_js)?
    {
        Some(opened_source) => {
            let was_progressive = pending.source.is_some();
            let source = match pending.source {
                Some(source) => {
                    state
                        .runtime
                        .replace_incremental_source(source, opened_source)
                        .map_err(error_to_js)?;
                    source
                }
                None => state
                    .runtime
                    .open_incremental_source(opened_source)
                    .map_err(error_to_js)?,
            };
            pending.source = Some(source);
            let metadata = state
                .runtime
                .source_metadata(source)
                .map_err(error_to_js)?
                .clone();
            let bytes_scanned = absolute_offset
                .checked_add(u64::try_from(bytes_len).map_err(|_| {
                    error_to_js(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Arrow ingress byte count exceeds the supported range",
                    ))
                })?)
                .ok_or_else(|| {
                    error_to_js(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Arrow ingress byte offset overflows",
                    ))
                })?;
            Ok((
                complete_open(
                    source,
                    &pending.table_name,
                    &metadata,
                    was_progressive.then_some(bytes_scanned),
                )?,
                true,
            ))
        }
        None => {
            let action = pending
                .operation
                .next_action()
                .map_err(error_to_js)?
                .ok_or_else(|| {
                    error_to_js(TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Arrow open operation stopped without a source",
                    ))
                })?;
            if let Some(prefix) = pending.operation.stream_prefix().map_err(error_to_js)? {
                let source = match pending.source {
                    Some(source) => {
                        state
                            .runtime
                            .replace_incremental_source(source, prefix)
                            .map_err(error_to_js)?;
                        source
                    }
                    None => state
                        .runtime
                        .open_incremental_source(prefix)
                        .map_err(error_to_js)?,
                };
                pending.source = Some(source);
                let metadata = state
                    .runtime
                    .source_metadata(source)
                    .map_err(error_to_js)?
                    .clone();
                return Ok((
                    progressive_open_action(
                        operation_handle,
                        action,
                        source,
                        &pending.table_name,
                        &metadata,
                    )?,
                    false,
                ));
            }
            Ok((operation_action(operation_handle, action)?, false))
        }
    }
}

fn operation_action(
    operation_handle: u32,
    action: ReadBytesAction,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(&result, "action", read_action_value(action)?)?;
    Ok(result.into())
}

fn progressive_open_action(
    operation_handle: u32,
    action: ReadBytesAction,
    source: ArrowSourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(&result, "action", read_action_value(action)?)?;
    set_open_identity(&result, source, table_name, metadata)?;
    set_open_progress(&result, source, action.offset, metadata, false)?;
    Ok(result.into())
}

fn complete_open(
    source: ArrowSourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
    bytes_scanned: Option<u64>,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "status", JsValue::from_str("complete"))?;
    set_open_identity(&result, source, table_name, metadata)?;
    if let Some(bytes_scanned) = bytes_scanned {
        set_open_progress(&result, source, bytes_scanned, metadata, true)?;
    }
    Ok(result.into())
}

fn read_action_value(action: ReadBytesAction) -> std::result::Result<JsValue, JsValue> {
    let action_value = Object::new();
    set(&action_value, "kind", JsValue::from_str("read-bytes"))?;
    set(
        &action_value,
        "offset",
        safe_integer_js(action.offset, "Arrow action offset")?,
    )?;
    set(
        &action_value,
        "length",
        safe_integer_js(action.length, "Arrow action length")?,
    )?;
    Ok(action_value.into())
}

fn set_open_identity(
    result: &Object,
    source: ArrowSourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
) -> std::result::Result<(), JsValue> {
    set(
        result,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(result, "metadata", to_js(metadata)?)?;
    let table = Object::new();
    set(&table, "id", JsValue::from_str("table-0"))?;
    set(&table, "name", JsValue::from_str(table_name))?;
    let tables = Array::new();
    tables.push(&table);
    set(result, "tables", tables.into())
}

fn set_open_progress(
    result: &Object,
    source: ArrowSourceHandle,
    bytes_scanned: u64,
    metadata: &TableMetadata,
    done: bool,
) -> std::result::Result<(), JsValue> {
    let rows_discovered = metadata.extent().rows().value().unwrap_or(0);
    let progress = Object::new();
    set(
        &progress,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(
        &progress,
        "bytesScanned",
        safe_integer_js(bytes_scanned, "Arrow progress bytes scanned")?,
    )?;
    set(
        &progress,
        "rowsDiscovered",
        safe_integer_js(rows_discovered, "Arrow progress rows discovered")?,
    )?;
    set(&progress, "done", JsValue::from_bool(done))?;
    set(result, "progress", progress.into())
}

fn complete_batch(batch: &TypedTableBatch) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "status", JsValue::from_str("complete"))?;
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

fn safe_usize(value: f64, field: &str) -> std::result::Result<usize, JsValue> {
    let value = safe_u64(value, field)?;
    usize::try_from(value).map_err(|_| {
        error_to_js(
            TabularkError::new(
                ErrorCode::InvalidArgument,
                format!("{field} exceeds the supported integer range"),
            )
            .with_detail("field", field),
        )
    })
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
                "invalid Arrow WebAssembly method payload",
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
                "failed to serialize Arrow WebAssembly method result",
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
        .unwrap_or_else(|_| JsValue::from_str("Tabulark Arrow runtime failure"))
}
