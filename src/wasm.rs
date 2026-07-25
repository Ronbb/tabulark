//! Adapter-ABI-v1 WebAssembly exports for the dedicated delimited artifact.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::Serialize;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::csv::{CsvDiagnostic, DelimitedOptions};
use crate::error::{ErrorCode, TabularkError};
use crate::model::{RangeRequest, TableMetadata, TypedTableBatch};
use crate::protocol::{
    ADAPTER_API_VERSION, BATCH_LAYOUT_VERSION, DELIMITED_ADAPTER_ID, PROTOCOL_VERSION,
};
use crate::runtime::{FeedRangeResult, RangeHandle, Runtime, RuntimeConfig, SourceHandle};

struct PendingOpen {
    source: SourceHandle,
    source_length: u64,
    next_offset: u64,
    table_name: String,
}

struct PendingRead {
    source: SourceHandle,
    source_length: u64,
    next_offset: u64,
    range: RangeHandle,
    table: u32,
}

enum PendingOperation {
    Open(PendingOpen),
    Read(PendingRead),
}

struct State {
    runtime: Runtime,
    chunk_bytes: u64,
    next_operation: u32,
    next_table: u32,
    operations: HashMap<u32, PendingOperation>,
    source_lengths: HashMap<SourceHandle, u64>,
    tables: HashMap<u32, SourceHandle>,
}

impl State {
    fn allocate_operation(&mut self) -> std::result::Result<u32, JsValue> {
        let operation = self.next_operation;
        self.next_operation = self.next_operation.checked_add(1).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "delimited operation handle space exhausted",
            ))
        })?;
        Ok(operation)
    }

    fn allocate_table(&mut self) -> std::result::Result<u32, JsValue> {
        let table = self.next_table;
        self.next_table = self.next_table.checked_add(1).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "delimited table handle space exhausted",
            ))
        })?;
        Ok(table)
    }

    fn cancel_pending(&mut self, operation: PendingOperation) {
        match operation {
            PendingOperation::Open(open) => {
                self.source_lengths.remove(&open.source);
                self.runtime.close_source(open.source);
            }
            PendingOperation::Read(read) => {
                self.runtime.cancel(read.range);
            }
        }
    }

    fn remove_operations_for_table(&mut self, table: u32) {
        let handles = self
            .operations
            .iter()
            .filter_map(|(handle, operation)| {
                matches!(operation, PendingOperation::Read(read) if read.table == table)
                    .then_some(*handle)
            })
            .collect::<Vec<_>>();
        for handle in handles {
            if let Some(operation) = self.operations.remove(&handle) {
                self.cancel_pending(operation);
            }
        }
    }

    fn remove_operations_for_source(&mut self, source: SourceHandle) {
        let handles = self
            .operations
            .iter()
            .filter_map(|(handle, operation)| match operation {
                PendingOperation::Open(open) if open.source == source => Some(*handle),
                PendingOperation::Read(read) if read.source == source => Some(*handle),
                _ => None,
            })
            .collect::<Vec<_>>();
        for handle in handles {
            if let Some(operation) = self.operations.remove(&handle) {
                self.cancel_pending(operation);
            }
        }
    }
}

/// Delimited adapter runtime implementing the same ABI as the Arrow artifact.
#[wasm_bindgen]
pub struct WasmRuntime {
    state: RefCell<State>,
}

#[wasm_bindgen]
impl WasmRuntime {
    /// Creates a runtime from a camel-case [`RuntimeConfig`] object.
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> std::result::Result<WasmRuntime, JsValue> {
        let config = if config.is_null() || config.is_undefined() {
            RuntimeConfig::default()
        } else {
            from_js(config)?
        };
        let chunk_bytes = u64::try_from(config.chunk_bytes).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "configured delimited chunk size exceeds the public range",
            ))
        })?;
        Ok(Self {
            state: RefCell::new(State {
                runtime: Runtime::new(config).map_err(error_to_js)?,
                chunk_bytes,
                next_operation: 1,
                next_table: 1,
                operations: HashMap::new(),
                source_lengths: HashMap::new(),
                tables: HashMap::new(),
            }),
        })
    }

    /// Returns the Worker protocol version implemented by this build.
    #[wasm_bindgen(js_name = protocolVersion)]
    pub fn protocol_version(&self) -> u32 {
        PROTOCOL_VERSION
    }

    /// Returns official adapter ABI version one.
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
        DELIMITED_ADAPTER_ID.to_owned()
    }

    /// Starts a progressive scan using bounded sequential byte actions.
    #[wasm_bindgen(js_name = beginOpen)]
    pub fn begin_open(
        &self,
        options: JsValue,
        source_length: f64,
    ) -> std::result::Result<JsValue, JsValue> {
        let source_length = safe_u64(source_length, "sourceLength")?;
        let options = if options.is_null() || options.is_undefined() {
            DelimitedOptions::default()
        } else {
            from_js(options)?
        };
        let table_name = options.table_name.clone();
        let mut state = self.state.borrow_mut();
        let source = state.runtime.open_delimited(options).map_err(error_to_js)?;
        let operation = match state.allocate_operation() {
            Ok(operation) => operation,
            Err(error) => {
                state.runtime.close_source(source);
                return Err(error);
            }
        };
        let pending = PendingOpen {
            source,
            source_length,
            next_offset: 0,
            table_name: table_name.clone(),
        };
        let action = match read_action(0, source_length, state.chunk_bytes) {
            Ok(action) => action,
            Err(error) => {
                state.runtime.close_source(source);
                return Err(error);
            }
        };
        let metadata = match state.runtime.metadata(source) {
            Ok(metadata) => metadata,
            Err(error) => {
                state.runtime.close_source(source);
                return Err(error_to_js(error));
            }
        };
        let result = match open_operation_action(
            operation,
            action,
            source,
            &table_name,
            &metadata,
            &[],
            0,
        ) {
            Ok(result) => result,
            Err(error) => {
                state.runtime.close_source(source);
                return Err(error);
            }
        };
        state.source_lengths.insert(source, source_length);
        state
            .operations
            .insert(operation, PendingOperation::Open(pending));
        Ok(result)
    }

    /// Supplies exactly one requested source chunk and advances an open or
    /// range-read operation.
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
                "delimited operation handle is closed",
            ))
        })?;
        match pending {
            PendingOperation::Open(mut pending) => {
                let expected = match read_action(
                    pending.next_offset,
                    pending.source_length,
                    state.chunk_bytes,
                ) {
                    Ok(action) => action,
                    Err(error) => {
                        state.cancel_pending(PendingOperation::Open(pending));
                        return Err(error);
                    }
                };
                if let Err(error) = validate_action(expected, absolute_offset, &owned, eof) {
                    state.cancel_pending(PendingOperation::Open(pending));
                    return Err(error_to_js(error));
                }
                let update =
                    match state
                        .runtime
                        .scan_chunk(pending.source, absolute_offset, &owned, eof)
                    {
                        Ok(update) => update,
                        Err(error) => {
                            state.cancel_pending(PendingOperation::Open(pending));
                            return Err(error_to_js(error));
                        }
                    };
                pending.next_offset = expected.end()?;
                if update.done {
                    let metadata = match state.runtime.metadata(pending.source) {
                        Ok(metadata) => metadata,
                        Err(error) => {
                            state.cancel_pending(PendingOperation::Open(pending));
                            return Err(error_to_js(error));
                        }
                    };
                    match complete_open(
                        pending.source,
                        &pending.table_name,
                        &metadata,
                        &update.warnings,
                        pending.next_offset,
                    ) {
                        Ok(result) => Ok(result),
                        Err(error) => {
                            state.source_lengths.remove(&pending.source);
                            state.runtime.close_source(pending.source);
                            Err(error)
                        }
                    }
                } else {
                    let action = match read_action(
                        pending.next_offset,
                        pending.source_length,
                        state.chunk_bytes,
                    ) {
                        Ok(action) => action,
                        Err(error) => {
                            state.cancel_pending(PendingOperation::Open(pending));
                            return Err(error);
                        }
                    };
                    let result = match open_operation_action(
                        operation_handle,
                        action,
                        pending.source,
                        &pending.table_name,
                        &update.metadata,
                        &update.warnings,
                        pending.next_offset,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            state.cancel_pending(PendingOperation::Open(pending));
                            return Err(error);
                        }
                    };
                    state
                        .operations
                        .insert(operation_handle, PendingOperation::Open(pending));
                    Ok(result)
                }
            }
            PendingOperation::Read(mut pending) => {
                let expected = match read_action(
                    pending.next_offset,
                    pending.source_length,
                    state.chunk_bytes,
                ) {
                    Ok(action) => action,
                    Err(error) => {
                        state.cancel_pending(PendingOperation::Read(pending));
                        return Err(error);
                    }
                };
                if let Err(error) = validate_action(expected, absolute_offset, &owned, eof) {
                    state.cancel_pending(PendingOperation::Read(pending));
                    return Err(error_to_js(error));
                }
                let update =
                    match state
                        .runtime
                        .feed_range(pending.range, absolute_offset, &owned, eof)
                    {
                        Ok(update) => update,
                        Err(error) => return Err(error_to_js(error)),
                    };
                match update {
                    FeedRangeResult::NeedMore {
                        expected_offset,
                        warnings: _,
                    } => {
                        if expected_offset > pending.source_length
                            || (expected_offset <= pending.next_offset && !eof)
                        {
                            state.runtime.cancel(pending.range);
                            return Err(error_to_js(TabularkError::new(
                                ErrorCode::RuntimeFailure,
                                "delimited range decoder returned an invalid next offset",
                            )));
                        }
                        pending.next_offset = expected_offset;
                        let action = match read_action(
                            pending.next_offset,
                            pending.source_length,
                            state.chunk_bytes,
                        ) {
                            Ok(action) => action,
                            Err(error) => {
                                state.runtime.cancel(pending.range);
                                return Err(error);
                            }
                        };
                        let result = match operation_action(operation_handle, action) {
                            Ok(result) => result,
                            Err(error) => {
                                state.runtime.cancel(pending.range);
                                return Err(error);
                            }
                        };
                        state
                            .operations
                            .insert(operation_handle, PendingOperation::Read(pending));
                        Ok(result)
                    }
                    FeedRangeResult::Complete { batch, warnings } => {
                        let batch = batch.to_typed().map_err(error_to_js)?;
                        complete_batch(&batch, &warnings)
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
        if table_id != "table-0" {
            return Err(error_to_js(TabularkError::new(
                ErrorCode::InvalidArgument,
                "delimited sources expose only table-0",
            )));
        }
        let source = SourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        let metadata = state.runtime.metadata(source).map_err(error_to_js)?;
        let table = state.allocate_table()?;
        let result = Object::new();
        set(&result, "tableHandle", JsValue::from_f64(f64::from(table)))?;
        set(&result, "metadata", to_js(&metadata)?)?;
        state.tables.insert(table, source);
        Ok(result.into())
    }

    /// Returns exact metadata for an opened table.
    pub fn metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        let source = *state.tables.get(&table_handle).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "delimited table handle is closed",
            ))
        })?;
        let metadata = state.runtime.metadata(source).map_err(error_to_js)?;
        to_js(&metadata)
    }

    /// Starts a checkpoint-backed range read using the common operation ABI.
    #[wasm_bindgen(js_name = beginRead)]
    pub fn begin_read(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let request: RangeRequest = from_js(request)?;
        let mut state = self.state.borrow_mut();
        let source = *state.tables.get(&table_handle).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "delimited table handle is closed",
            ))
        })?;
        let source_length = *state.source_lengths.get(&source).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "delimited source handle is closed",
            ))
        })?;
        let start = state
            .runtime
            .begin_range(source, request)
            .map_err(error_to_js)?;
        if let Some(batch) = start.batch {
            return complete_batch(&batch.to_typed().map_err(error_to_js)?, &[]);
        }
        let operation = match state.allocate_operation() {
            Ok(operation) => operation,
            Err(error) => {
                state.runtime.cancel(start.range_handle);
                return Err(error);
            }
        };
        let next_offset = start.plan.source_offset();
        let action = match read_action(next_offset, source_length, state.chunk_bytes) {
            Ok(action) => action,
            Err(error) => {
                state.runtime.cancel(start.range_handle);
                return Err(error);
            }
        };
        let result = match operation_action(operation, action) {
            Ok(result) => result,
            Err(error) => {
                state.runtime.cancel(start.range_handle);
                return Err(error);
            }
        };
        state.operations.insert(
            operation,
            PendingOperation::Read(PendingRead {
                source,
                source_length,
                next_offset,
                range: start.range_handle,
                table: table_handle,
            }),
        );
        Ok(result)
    }

    /// Cancels and releases a pending open or read operation.
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
        let mut state = self.state.borrow_mut();
        state.remove_operations_for_table(table_handle);
        state.tables.remove(&table_handle).is_some()
    }

    /// Idempotently closes one source, all child tables, and all operations.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        let source = SourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        state.remove_operations_for_source(source);
        state.tables.retain(|_, owner| *owner != source);
        state.source_lengths.remove(&source);
        state.runtime.close_source(source)
    }

    /// Releases every operation, table, and source handle.
    pub fn shutdown(&self) {
        let mut state = self.state.borrow_mut();
        state.operations.clear();
        state.tables.clear();
        state.source_lengths.clear();
        state.runtime.shutdown();
    }
}

#[derive(Clone, Copy)]
struct ReadAction {
    offset: u64,
    length: u64,
    eof: bool,
}

impl ReadAction {
    fn end(self) -> std::result::Result<u64, JsValue> {
        self.offset.checked_add(self.length).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "delimited ingress byte range overflows",
            ))
        })
    }
}

fn read_action(
    offset: u64,
    source_length: u64,
    chunk_bytes: u64,
) -> std::result::Result<ReadAction, JsValue> {
    if offset > source_length {
        return Err(error_to_js(TabularkError::new(
            ErrorCode::RuntimeFailure,
            "delimited operation offset exceeds the source length",
        )));
    }
    Ok(ReadAction {
        offset,
        length: source_length.saturating_sub(offset).min(chunk_bytes),
        eof: offset
            .checked_add(source_length.saturating_sub(offset).min(chunk_bytes))
            .is_some_and(|end| end == source_length),
    })
}

fn validate_action(action: ReadAction, offset: u64, bytes: &[u8], eof: bool) -> crate::Result<()> {
    let length = u64::try_from(bytes.len()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "delimited ingress chunk exceeds the supported range",
        )
    })?;
    if offset != action.offset || length != action.length || eof != action.eof {
        return Err(TabularkError::new(
            ErrorCode::InvalidArgument,
            "delimited ingress bytes do not match the requested read action",
        )
        .with_detail("expectedOffset", action.offset)
        .with_detail("expectedLength", action.length)
        .with_detail("expectedEof", action.eof));
    }
    Ok(())
}

fn operation_action(
    operation_handle: u32,
    action: ReadAction,
) -> std::result::Result<JsValue, JsValue> {
    let action_value = Object::new();
    set(&action_value, "kind", JsValue::from_str("read-bytes"))?;
    set(
        &action_value,
        "offset",
        JsValue::from_f64(action.offset as f64),
    )?;
    set(
        &action_value,
        "length",
        JsValue::from_f64(action.length as f64),
    )?;
    let result = Object::new();
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(&result, "action", action_value.into())?;
    Ok(result.into())
}

/// Adds the progressive source state carried by a pending delimited-open action.
///
/// This is deliberately an optional extension of adapter ABI v1 rather than a
/// separate method: a Worker can hand the pending action to a background scan
/// after its initial preview prefix is available, while Arrow and range reads
/// retain the common `read-bytes` action contract unchanged.
fn open_operation_action(
    operation_handle: u32,
    action: ReadAction,
    source: SourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
    warnings: &[CsvDiagnostic],
    bytes_scanned: u64,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::from(operation_action(operation_handle, action)?);
    set(
        &result,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(&result, "metadata", to_js(metadata)?)?;
    set(&result, "tables", table_descriptors(table_name)?.into())?;
    set(
        &result,
        "progress",
        progress_value(source, metadata, bytes_scanned, false)?,
    )?;
    if !warnings.is_empty() {
        set(&result, "warnings", to_js(warnings)?)?;
    }
    Ok(result.into())
}

fn complete_open(
    source: SourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
    warnings: &[CsvDiagnostic],
    bytes_scanned: u64,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "status", JsValue::from_str("complete"))?;
    set(
        &result,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(&result, "metadata", to_js(metadata)?)?;
    set(
        &result,
        "progress",
        progress_value(source, metadata, bytes_scanned, true)?,
    )?;
    if !warnings.is_empty() {
        set(&result, "warnings", to_js(warnings)?)?;
    }
    set(&result, "tables", table_descriptors(table_name)?.into())?;
    Ok(result.into())
}

fn table_descriptors(table_name: &str) -> std::result::Result<Array, JsValue> {
    let table = Object::new();
    set(&table, "id", JsValue::from_str("table-0"))?;
    set(&table, "name", JsValue::from_str(table_name))?;
    let tables = Array::new();
    tables.push(&table);
    Ok(tables)
}

fn progress_value(
    source: SourceHandle,
    metadata: &TableMetadata,
    bytes_scanned: u64,
    done: bool,
) -> std::result::Result<JsValue, JsValue> {
    let progress = Object::new();
    set(
        &progress,
        "sourceHandle",
        JsValue::from_f64(f64::from(source.get())),
    )?;
    set(
        &progress,
        "bytesScanned",
        JsValue::from_f64(bytes_scanned as f64),
    )?;
    set(
        &progress,
        "rowsDiscovered",
        JsValue::from_f64(metadata.extent().rows().value().unwrap_or(0) as f64),
    )?;
    set(&progress, "done", JsValue::from_bool(done))?;
    Ok(progress.into())
}

fn complete_batch(
    batch: &TypedTableBatch,
    warnings: &[CsvDiagnostic],
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::new();
    set(&result, "status", JsValue::from_str("complete"))?;
    set(&result, "batch", batch_to_js(batch)?)?;
    if !warnings.is_empty() {
        set(&result, "warnings", to_js(warnings)?)?;
    }
    Ok(result.into())
}

fn batch_to_js(batch: &TypedTableBatch) -> std::result::Result<JsValue, JsValue> {
    let object = Object::new();
    set(
        &object,
        "layoutVersion",
        JsValue::from_f64(f64::from(batch.layout_version())),
    )?;
    set(&object, "tableId", JsValue::from_str(batch.table_id()))?;
    set(
        &object,
        "revision",
        JsValue::from_f64(batch.revision() as f64),
    )?;
    set(
        &object,
        "schemaVersion",
        JsValue::from_f64(batch.schema_version() as f64),
    )?;
    set(&object, "range", to_js(&batch.range())?)?;
    set(&object, "complete", JsValue::from_bool(batch.complete()))?;
    let buffers = Array::new();
    for buffer in batch.buffers() {
        buffers.push(&Uint8Array::from(buffer.data()));
    }
    set(&object, "buffers", buffers.into())?;
    set(&object, "columns", to_js(batch.columns())?)?;
    Ok(object.into())
}

fn set(object: &Object, key: &str, value: JsValue) -> std::result::Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value).map(|_| ())
}

fn safe_u64(value: f64, field: &str) -> std::result::Result<u64, JsValue> {
    if !value.is_finite()
        || value < 0.0
        || value.fract() != 0.0
        || value > crate::model::MAX_SAFE_INTEGER as f64
    {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::InvalidArgument,
                format!("{field} must be a non-negative JavaScript safe integer"),
            )
            .with_detail("field", field),
        ));
    }
    Ok(value as u64)
}

fn from_js<T>(value: JsValue) -> std::result::Result<T, JsValue>
where
    T: for<'de> serde::Deserialize<'de>,
{
    serde_wasm_bindgen::from_value(value).map_err(|error| {
        error_to_js(
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "invalid delimited WebAssembly method payload",
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
                "failed to serialize delimited WebAssembly method result",
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
        .unwrap_or_else(|_| JsValue::from_str("Tabulark delimited runtime failure"))
}

#[cfg(test)]
mod tests {
    use super::read_action;

    #[test]
    fn read_actions_mark_only_the_final_chunk_as_eof() {
        let chunk = 1024 * 1024;
        let source = 2 * chunk;

        let first = read_action(0, source, chunk).expect("first action is valid");
        assert_eq!(first.offset, 0);
        assert_eq!(first.length, chunk);
        assert!(!first.eof);

        let final_chunk = read_action(chunk, source, chunk).expect("final action is valid");
        assert_eq!(final_chunk.offset, chunk);
        assert_eq!(final_chunk.length, chunk);
        assert!(final_chunk.eof);
    }

    #[test]
    fn empty_sources_request_a_zero_length_eof_action() {
        let action = read_action(0, 0, 1024 * 1024).expect("empty source action is valid");

        assert_eq!(action.offset, 0);
        assert_eq!(action.length, 0);
        assert!(action.eof);
    }
}
