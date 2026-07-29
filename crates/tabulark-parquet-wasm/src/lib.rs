//! Thin WebAssembly wrapper for the range-driven Parquet adapter.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use tabulark::model::{RangeRequest, TableMetadata, TypedTableBatch};
use tabulark::parquet::{
    ParquetLimits, ParquetOpenOperation, ParquetOptions, ParquetReadBytesAction,
    ParquetReadOperation, ParquetReadStart, ParquetRuntime, ParquetRuntimeConfig,
    ParquetSourceHandle, ParquetTableHandle,
};
use tabulark::protocol::{
    ADAPTER_API_VERSION, AdapterAction, AdapterActionResult, AdapterOperationCursor,
    BATCH_LAYOUT_VERSION, MAX_OPERATION_RANGES_PER_STEP, PARQUET_ADAPTER_ID, PROTOCOL_VERSION,
};
use tabulark::resource::{ResourceCategory, ResourceLedger};
use tabulark::{ErrorCode, TabularkError};
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmReadRequest {
    #[serde(flatten)]
    range: RangeRequest,
    #[serde(default)]
    display_only: bool,
}

struct PendingRead {
    operation: ParquetReadOperation,
    source: ParquetSourceHandle,
    table: ParquetTableHandle,
}

enum PendingOperation {
    Open(Box<ParquetOpenOperation>),
    Read(Box<PendingRead>),
}

struct TrackedOperation {
    cursor: AdapterOperationCursor,
    pending: PendingOperation,
}

struct State {
    runtime: ParquetRuntime,
    limits: ParquetLimits,
    operation_budget_bytes: u64,
    ledger: ResourceLedger,
    next_operation: u32,
    operations: HashMap<u32, TrackedOperation>,
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

/// Official Parquet runtime implementing adapter ABI v3.
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
        let operation_budget_bytes = u64::try_from(config.memory_budget_bytes).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet operation budget exceeds u64",
            ))
        })?;
        Ok(Self {
            state: RefCell::new(State {
                runtime: ParquetRuntime::new(config).map_err(error_to_js)?,
                limits,
                operation_budget_bytes,
                ledger: ResourceLedger::new(operation_budget_bytes).map_err(error_to_js)?,
                next_operation: 1,
                operations: HashMap::new(),
                table_sources: HashMap::new(),
            }),
        })
    }

    /// Returns Worker protocol version four.
    #[wasm_bindgen(js_name = protocolVersion)]
    pub fn protocol_version(&self) -> u32 {
        PROTOCOL_VERSION
    }

    /// Returns official adapter ABI version three.
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

    /// Returns the private adapter-owned resource ledger snapshot.
    #[wasm_bindgen(js_name = resourceSnapshot)]
    pub fn resource_snapshot(&self) -> std::result::Result<JsValue, JsValue> {
        let wasm_memory_pages = current_wasm_memory_pages();
        let mut state = self.state.borrow_mut();
        let persistent = u64::try_from(state.runtime.retained_bytes()).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet retained-byte estimate exceeds u64",
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
                    "Parquet active-operation estimate overflows",
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
        let mut cursor = AdapterOperationCursor::new();
        let result = operation_action(handle, &mut cursor, action, state.operation_budget_bytes)?;
        state.operations.insert(
            handle,
            TrackedOperation {
                cursor,
                pending: PendingOperation::Open(Box::new(operation)),
            },
        );
        Ok(result)
    }

    /// Supplies one complete revision-matched source result set.
    #[wasm_bindgen(js_name = continueOperation)]
    pub fn continue_operation(
        &self,
        operation_handle: u32,
        operation_revision: f64,
        results: Array,
    ) -> std::result::Result<JsValue, JsValue> {
        let operation_revision = safe_u64(operation_revision, "operationRevision")?;
        let mut results = operation_results(results)?;
        let descriptors = results
            .iter()
            .map(|result| result.descriptor)
            .collect::<Vec<_>>();
        let mut state = self.state.borrow_mut();
        let tracked = state.operations.get_mut(&operation_handle).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Parquet operation handle is closed",
            ))
        })?;
        tracked
            .cursor
            .validate_results(operation_revision, &descriptors)
            .map_err(error_to_js)?;
        let TrackedOperation {
            mut cursor,
            pending,
        } = state
            .operations
            .remove(&operation_handle)
            .expect("validated Parquet operation remains registered");
        match pending {
            PendingOperation::Open(mut operation) => {
                let result = results
                    .pop()
                    .expect("validated Parquet open has one source result");
                match operation
                    .feed_owned(
                        result.descriptor.offset,
                        result.bytes,
                        result.descriptor.eof,
                    )
                    .map_err(error_to_js)?
                {
                    Some(source) => {
                        let source_length = source.source_length();
                        let metadata = source.metadata().clone();
                        let source = state.runtime.open_source(source).map_err(error_to_js)?;
                        let revision = cursor.complete_revision().map_err(error_to_js)?;
                        complete_open(operation_handle, revision, source, &metadata, source_length)
                    }
                    None => {
                        let action = operation.next_action().ok_or_else(|| {
                            error_to_js(TabularkError::new(
                                ErrorCode::RuntimeFailure,
                                "Parquet open stopped without a source or byte action",
                            ))
                        })?;
                        let result = operation_action(
                            operation_handle,
                            &mut cursor,
                            action,
                            state.operation_budget_bytes,
                        )?;
                        state.operations.insert(
                            operation_handle,
                            TrackedOperation {
                                cursor,
                                pending: PendingOperation::Open(operation),
                            },
                        );
                        Ok(result)
                    }
                }
            }
            PendingOperation::Read(mut pending) => {
                results.sort_unstable_by_key(|result| result.descriptor.action_index);
                let ingress = results
                    .into_iter()
                    .map(|result| {
                        (
                            result.descriptor.offset,
                            result.bytes,
                            result.descriptor.eof,
                        )
                    })
                    .collect();
                match pending
                    .operation
                    .feed_many_owned(ingress)
                    .map_err(error_to_js)?
                {
                    Some(batch) => {
                        let revision = cursor.complete_revision().map_err(error_to_js)?;
                        complete_batch(operation_handle, revision, batch)
                    }
                    None => {
                        let actions = pending
                            .operation
                            .next_actions(
                                MAX_OPERATION_RANGES_PER_STEP,
                                state.operation_budget_bytes,
                            )
                            .map_err(error_to_js)?;
                        if actions.is_empty() {
                            return Err(error_to_js(TabularkError::new(
                                ErrorCode::RuntimeFailure,
                                "Parquet read stopped without a batch or byte action",
                            )));
                        }
                        let result = operation_actions(
                            operation_handle,
                            &mut cursor,
                            &actions,
                            state.operation_budget_bytes,
                        )?;
                        state.operations.insert(
                            operation_handle,
                            TrackedOperation {
                                cursor,
                                pending: PendingOperation::Read(pending),
                            },
                        );
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

    /// Starts and completes an ABI-v3 open-table operation.
    #[wasm_bindgen(js_name = beginOpenTable)]
    pub fn begin_open_table(
        &self,
        source_handle: u32,
        table_id: String,
    ) -> std::result::Result<JsValue, JsValue> {
        let opened = self.open_table(source_handle, table_id)?;
        let mut state = self.state.borrow_mut();
        let handle = state.allocate_operation()?;
        complete_value(handle, "open-table", "table", opened)
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

    /// Starts and completes an ABI-v3 metadata operation.
    #[wasm_bindgen(js_name = beginMetadata)]
    pub fn begin_metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let metadata = self.metadata(table_handle)?;
        let mut state = self.state.borrow_mut();
        let handle = state.allocate_operation()?;
        complete_value(handle, "metadata", "metadata", metadata)
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

    /// Starts and completes an ABI-v3 static-presentation operation.
    #[wasm_bindgen(js_name = beginPresentation)]
    pub fn begin_presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let presentation = self.presentation(table_handle)?;
        let mut state = self.state.borrow_mut();
        let handle = state.allocate_operation()?;
        complete_value(handle, "presentation", "presentation", presentation)
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

    /// Starts and completes an ABI-v3 range-presentation operation.
    #[wasm_bindgen(js_name = beginPresentationRange)]
    pub fn begin_presentation_range(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let presentation = self.read_presentation_range(table_handle, request)?;
        let mut state = self.state.borrow_mut();
        let handle = state.allocate_operation()?;
        complete_value(handle, "presentation-range", "presentation", presentation)
    }

    /// Starts a row-group and top-level-column projected range read.
    #[wasm_bindgen(js_name = beginRead)]
    pub fn begin_read(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let request: WasmReadRequest = from_js(request)?;
        let table = ParquetTableHandle::from_raw(table_handle);
        let mut state = self.state.borrow_mut();
        let source = *state.table_sources.get(&table).ok_or_else(|| {
            error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "Parquet table handle is closed",
            ))
        })?;
        let read = if request.display_only {
            state.runtime.begin_display_read(table, request.range)
        } else {
            state.runtime.begin_read(table, request.range)
        }
        .map_err(error_to_js)?;
        match read {
            ParquetReadStart::Complete(batch) => {
                let handle = state.allocate_operation()?;
                let mut cursor = AdapterOperationCursor::new();
                let revision = cursor.complete_revision().map_err(error_to_js)?;
                complete_batch(handle, revision, batch)
            }
            ParquetReadStart::Pending(operation) => {
                let actions = operation
                    .next_actions(MAX_OPERATION_RANGES_PER_STEP, state.operation_budget_bytes)
                    .map_err(error_to_js)?;
                if actions.is_empty() {
                    return Err(error_to_js(TabularkError::new(
                        ErrorCode::RuntimeFailure,
                        "Parquet range read produced no initial byte action",
                    )));
                }
                let handle = state.allocate_operation()?;
                let mut cursor = AdapterOperationCursor::new();
                let result =
                    operation_actions(handle, &mut cursor, &actions, state.operation_budget_bytes)?;
                state.operations.insert(
                    handle,
                    TrackedOperation {
                        cursor,
                        pending: PendingOperation::Read(Box::new(PendingRead {
                            operation: *operation,
                            source,
                            table,
                        })),
                    },
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
            |_, operation| !matches!(&operation.pending, PendingOperation::Read(read) if read.table == table),
        );
        state.runtime.close_table(table)
    }

    /// Idempotently closes a source, its tables, and child reads.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        let source = ParquetSourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        state.operations.retain(
            |_, operation| !matches!(&operation.pending, PendingOperation::Read(read) if read.source == source),
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
        state.ledger.release_all();
    }
}

fn operation_action(
    operation_handle: u32,
    cursor: &mut AdapterOperationCursor,
    action: ParquetReadBytesAction,
    operation_budget_bytes: u64,
) -> std::result::Result<JsValue, JsValue> {
    operation_actions(operation_handle, cursor, &[action], operation_budget_bytes)
}

fn operation_actions(
    operation_handle: u32,
    cursor: &mut AdapterOperationCursor,
    actions_to_issue: &[ParquetReadBytesAction],
    operation_budget_bytes: u64,
) -> std::result::Result<JsValue, JsValue> {
    let adapter_actions = actions_to_issue
        .iter()
        .enumerate()
        .map(|(index, action)| {
            Ok(AdapterAction::indexed_read_bytes(
                u32::try_from(index).map_err(|_| {
                    error_to_js(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Parquet action index exceeds u32",
                    ))
                })?,
                action.offset,
                action.length,
            ))
        })
        .collect::<std::result::Result<Vec<_>, JsValue>>()?;
    let operation_revision = cursor
        .issue(adapter_actions, operation_budget_bytes)
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
        safe_integer_js(operation_revision, "Parquet operation revision")?,
    )?;
    let actions = Array::new();
    for (index, action) in actions_to_issue.iter().copied().enumerate() {
        let action_value = Object::new();
        set(&action_value, "kind", JsValue::from_str("read-bytes"))?;
        set(
            &action_value,
            "actionIndex",
            JsValue::from_f64(f64::from(u32::try_from(index).map_err(|_| {
                error_to_js(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Parquet action index exceeds u32",
                ))
            })?)),
        )?;
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
        actions.push(&action_value);
    }
    set(&result, "actions", actions.into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    Ok(result.into())
}

fn complete_open(
    operation_handle: u32,
    operation_revision: u64,
    source: ParquetSourceHandle,
    metadata: &TableMetadata,
    source_length: u64,
) -> std::result::Result<JsValue, JsValue> {
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
        safe_integer_js(operation_revision, "Parquet operation revision")?,
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
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

fn complete_batch(
    operation_handle: u32,
    operation_revision: u64,
    batch: TypedTableBatch,
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
        safe_integer_js(operation_revision, "Parquet operation revision")?,
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    set(&result, "batch", batch_to_js(batch)?)?;
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
        safe_integer_js(revision, "Parquet operation revision")?,
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
            "Parquet result count exceeds usize",
        ))
    })?;
    if count > MAX_OPERATION_RANGES_PER_STEP {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Parquet operation supplied too many source results",
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
        TabularkError::new(
            ErrorCode::InvalidArgument,
            "invalid Parquet operation result",
        )
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

fn batch_to_js(batch: TypedTableBatch) -> std::result::Result<JsValue, JsValue> {
    let columns = to_js(batch.columns())?;
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
    for buffer in batch.into_buffers() {
        let data = buffer.into_data();
        buffers.push(&Uint8Array::from(data.as_slice()));
    }
    set(&result, "buffers", buffers.into())?;
    set(&result, "columns", columns)?;
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
