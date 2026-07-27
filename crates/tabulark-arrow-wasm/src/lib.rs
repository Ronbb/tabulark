//! Thin, publish-disabled WebAssembly wrapper for the Arrow IPC adapter.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::Serialize;
use tabulark::arrow::{
    ArrowFileReadOperation, ArrowIpcLimits, ArrowIpcOpenOperation, ArrowIpcOptions,
    ArrowIpcRuntime, ArrowReadStart, ArrowRuntimeConfig, ArrowSourceHandle, ArrowTableHandle,
    ReadBytesAction, ResolvedArrowIpcContainer,
};
use tabulark::model::{RangeRequest, TableMetadata, TypedTableBatch};
use tabulark::protocol::{
    ADAPTER_API_VERSION, ARROW_IPC_ADAPTER_ID, AdapterAction, AdapterActionResult,
    AdapterOperationCursor, BATCH_LAYOUT_VERSION, MAX_OPERATION_RANGES_PER_STEP, PROTOCOL_VERSION,
};
use tabulark::resource::{ResourceCategory, ResourceLedger};
use tabulark::{ErrorCode, TabularkError};
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};

/// Maximum source address accepted by the incremental range boundary.
///
/// Local Blob staging is governed by the host's separate 2-GiB contract. A
/// range source never materializes the source in WASM and may use the full
/// 32-bit byte address space (`2^32 - 1`).
const MAX_RANGE_SOURCE_BYTES: u64 = u32::MAX as u64;

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

struct TrackedOperation {
    cursor: AdapterOperationCursor,
    pending: PendingOperation,
}

struct State {
    runtime: ArrowIpcRuntime,
    memory_budget_bytes: usize,
    operation_budget_bytes: u64,
    ledger: ResourceLedger,
    next_operation: u32,
    operations: HashMap<u32, TrackedOperation>,
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

/// Dedicated Arrow IPC runtime artifact implementing adapter ABI v3.
#[wasm_bindgen]
pub struct WasmRuntime {
    state: RefCell<State>,
}

#[wasm_bindgen]
impl WasmRuntime {
    /// Creates an empty Arrow adapter runtime.
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> std::result::Result<WasmRuntime, JsValue> {
        let config = if config.is_null() || config.is_undefined() {
            ArrowRuntimeConfig::default()
        } else {
            from_js(config)?
        };
        let memory_budget_bytes = config.memory_budget_bytes;
        let operation_budget_bytes = u64::try_from(memory_budget_bytes).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow operation budget exceeds u64",
            ))
        })?;
        Ok(Self {
            state: RefCell::new(State {
                runtime: ArrowIpcRuntime::new(config).map_err(error_to_js)?,
                memory_budget_bytes,
                operation_budget_bytes,
                ledger: ResourceLedger::new(operation_budget_bytes).map_err(error_to_js)?,
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

    /// Returns the private adapter-owned resource ledger snapshot.
    #[wasm_bindgen(js_name = resourceSnapshot)]
    pub fn resource_snapshot(&self) -> std::result::Result<JsValue, JsValue> {
        let wasm_memory_pages = current_wasm_memory_pages();
        let mut state = self.state.borrow_mut();
        let persistent = u64::try_from(state.runtime.retained_bytes()).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow retained-byte estimate exceeds u64",
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
                    "Arrow active-operation estimate overflows",
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

    /// Begins an open without copying the full source into WebAssembly.
    ///
    /// IPC Files request only their trailer, footer, and batched dictionary/
    /// record metadata here.
    /// IPC Streams request bounded sequential chunks.
    #[wasm_bindgen(js_name = beginOpen)]
    pub fn begin_open(
        &self,
        options: JsValue,
        source_length: f64,
    ) -> std::result::Result<JsValue, JsValue> {
        // Validate the format-independent range address limit while the
        // value is still a u64. On wasm32, converting a value just above
        // `u32::MAX` to `usize` first would incorrectly report INVALID_ARGUMENT
        // instead of the required RESOURCE_LIMIT.
        let source_length_u64 = safe_u64(source_length, "sourceLength")?;
        validate_incremental_source_length(source_length_u64).map_err(error_to_js)?;
        let source_length = usize::try_from(source_length_u64).map_err(|_| {
            error_to_js(
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow IPC source length exceeds the runtime address space",
                )
                .with_detail("sourceBytes", source_length_u64),
            )
        })?;
        let mut options = if options.is_null() || options.is_undefined() {
            ArrowIpcOptions::default()
        } else {
            from_js(options)?
        };
        // Fail before the first ingress action when the Worker has supplied
        // limits that cannot fit the engine it just constructed.  Without
        // this check a Stream could spend its full sequential scan only to
        // fail while registering the completed source.
        let memory_budget_bytes = self.state.borrow().memory_budget_bytes;
        // Resource limits are host policy. Derive them from the allocation
        // made by the Worker ledger rather than retaining the native default
        // ceiling when stable JS options omit private limit fields.
        options.limits = incremental_limits(memory_budget_bytes).map_err(error_to_js)?;
        options
            .limits
            .validate_for_memory_budget(memory_budget_bytes)
            .map_err(error_to_js)?;
        let operation_budget_bytes = u64::try_from(memory_budget_bytes).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow operation budget exceeds u64",
            ))
        })?;
        let table_name = options.table_name.clone();
        let operation = ArrowIpcOpenOperation::new(source_length, options).map_err(error_to_js)?;
        let actions = operation
            .next_actions(MAX_OPERATION_RANGES_PER_STEP, operation_budget_bytes)
            .map_err(error_to_js)?;
        if actions.is_empty() {
            return Err(error_to_js(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Arrow open operation produced no initial byte action",
            )));
        }
        let mut state = self.state.borrow_mut();
        let handle = state.allocate_operation()?;
        let mut cursor = AdapterOperationCursor::new();
        let result =
            operation_actions(handle, &mut cursor, &actions, state.operation_budget_bytes)?;
        state.operations.insert(
            handle,
            TrackedOperation {
                cursor,
                pending: PendingOperation::Open(Box::new(PendingOpen {
                    operation,
                    table_name,
                    source: None,
                })),
            },
        );
        Ok(result)
    }

    /// Supplies one complete revision-matched source result set and advances
    /// an open or File range-read operation.
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
                "Arrow operation handle is closed",
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
            .expect("validated Arrow operation remains registered");
        match pending {
            PendingOperation::Open(mut pending) => {
                results.sort_unstable_by_key(|result| result.descriptor.action_index);
                match advance_open(
                    &mut state,
                    operation_handle,
                    &mut cursor,
                    results,
                    &mut pending,
                ) {
                    Ok((result, true)) => Ok(result),
                    Ok((result, false)) => {
                        state.operations.insert(
                            operation_handle,
                            TrackedOperation {
                                cursor,
                                pending: PendingOperation::Open(pending),
                            },
                        );
                        Ok(result)
                    }
                    Err(error) => {
                        state.close_pending_open(&pending);
                        Err(error)
                    }
                }
            }
            PendingOperation::Read(mut pending) => {
                let result = results
                    .pop()
                    .expect("validated Arrow File read has one source result");
                let absolute_offset = result.descriptor.offset;
                let eof = result.descriptor.eof;
                match pending
                    .operation
                    .feed_owned(absolute_offset, result.bytes, eof)
                    .map_err(error_to_js)?
                {
                    Some(batch) => {
                        let revision = cursor.complete_revision().map_err(error_to_js)?;
                        complete_batch(operation_handle, revision, &batch)
                    }
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

    /// Starts and synchronously completes an open-table operation using the
    /// common ABI-v3 step envelope.
    #[wasm_bindgen(js_name = beginOpenTable)]
    pub fn begin_open_table(
        &self,
        source_handle: u32,
        table_id: String,
    ) -> std::result::Result<JsValue, JsValue> {
        let opened = self.open_table(source_handle, table_id)?;
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        complete_value(operation, "open-table", "table", opened)
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

    /// Starts and synchronously completes a metadata operation.
    #[wasm_bindgen(js_name = beginMetadata)]
    pub fn begin_metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let metadata = self.metadata(table_handle)?;
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        complete_value(operation, "metadata", "metadata", metadata)
    }

    /// Returns no static presentation for Arrow IPC tables.
    pub fn presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        state
            .runtime
            .metadata(ArrowTableHandle::from_raw(table_handle))
            .map_err(error_to_js)?;
        Ok(JsValue::NULL)
    }

    /// Starts and synchronously completes a static-presentation operation.
    #[wasm_bindgen(js_name = beginPresentation)]
    pub fn begin_presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let presentation = self.presentation(table_handle)?;
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        complete_value(operation, "presentation", "presentation", presentation)
    }

    /// Returns no range presentation for Arrow IPC tables.
    #[wasm_bindgen(js_name = readPresentationRange)]
    pub fn read_presentation_range(
        &self,
        table_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let _: RangeRequest = from_js(request)?;
        self.presentation(table_handle)
    }

    /// Starts and synchronously completes a range-presentation operation.
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
            ArrowReadStart::Complete(batch) => {
                let handle = state.allocate_operation()?;
                let mut cursor = AdapterOperationCursor::new();
                let revision = cursor.complete_revision().map_err(error_to_js)?;
                complete_batch(handle, revision, &batch)
            }
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
                let mut cursor = AdapterOperationCursor::new();
                let result =
                    operation_action(handle, &mut cursor, action, state.operation_budget_bytes)?;
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

    /// Cancels and releases a pending adapter operation.
    #[wasm_bindgen(js_name = cancelOperation)]
    pub fn cancel_operation(&self, operation_handle: u32) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(operation) = state.operations.remove(&operation_handle) else {
            return false;
        };
        state.cancel_pending(operation.pending);
        true
    }

    /// Idempotently closes one table and its in-flight reads.
    #[wasm_bindgen(js_name = closeTable)]
    pub fn close_table(&self, table_handle: u32) -> bool {
        let table = ArrowTableHandle::from_raw(table_handle);
        let mut state = self.state.borrow_mut();
        state.table_sources.remove(&table);
        state.operations.retain(|_, operation| {
            !matches!(&operation.pending, PendingOperation::Read(read) if read.table == table)
        });
        state.runtime.close_table(table)
    }

    /// Idempotently closes one source, its tables, and all child reads.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        let source = ArrowSourceHandle::from_raw(source_handle);
        let mut state = self.state.borrow_mut();
        state.operations.retain(|_, operation| {
            !matches!(&operation.pending, PendingOperation::Read(read) if read.source == source)
                && !matches!(&operation.pending, PendingOperation::Open(open) if open.source == Some(source))
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
        state.ledger.release_all();
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
    cursor: &mut AdapterOperationCursor,
    results: Vec<OwnedActionResult>,
    pending: &mut PendingOpen,
) -> std::result::Result<(JsValue, bool), JsValue> {
    let bytes_scanned = results.iter().try_fold(0_u64, |scanned, result| {
        result
            .descriptor
            .offset
            .checked_add(result.descriptor.length)
            .map(|end| scanned.max(end))
            .ok_or_else(|| {
                error_to_js(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow ingress byte offset overflows",
                ))
            })
    })?;
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
        Some(opened_source) => {
            let was_progressive = pending.source.is_some();
            let source = match pending.source {
                Some(source) => {
                    if opened_source.container() == ResolvedArrowIpcContainer::Stream {
                        let delta = pending
                            .operation
                            .take_completed_stream_delta(opened_source)
                            .map_err(error_to_js)?;
                        state
                            .runtime
                            .append_incremental_stream(source, delta)
                            .map_err(error_to_js)?;
                    } else {
                        state
                            .runtime
                            .replace_incremental_source(source, opened_source)
                            .map_err(error_to_js)?;
                    }
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
            Ok((
                complete_open(
                    operation_handle,
                    cursor.complete_revision().map_err(error_to_js)?,
                    source,
                    &pending.table_name,
                    &metadata,
                    was_progressive.then_some(bytes_scanned),
                )?,
                true,
            ))
        }
        None => {
            let actions = pending
                .operation
                .next_actions(MAX_OPERATION_RANGES_PER_STEP, state.operation_budget_bytes)
                .map_err(error_to_js)?;
            if actions.is_empty() {
                return Err(error_to_js(TabularkError::new(
                    ErrorCode::RuntimeFailure,
                    "Arrow open operation stopped without a source",
                )));
            }
            if let Some(delta) = pending.operation.take_stream_delta().map_err(error_to_js)? {
                let source = match pending.source {
                    Some(source) => {
                        state
                            .runtime
                            .append_incremental_stream(source, delta)
                            .map_err(error_to_js)?;
                        source
                    }
                    None => state
                        .runtime
                        .open_incremental_stream(delta)
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
                        cursor,
                        &actions,
                        source,
                        &pending.table_name,
                        &metadata,
                        state.operation_budget_bytes,
                    )?,
                    false,
                ));
            }
            Ok((
                operation_actions(
                    operation_handle,
                    cursor,
                    &actions,
                    state.operation_budget_bytes,
                )?,
                false,
            ))
        }
    }
}

fn operation_action(
    operation_handle: u32,
    cursor: &mut AdapterOperationCursor,
    action: ReadBytesAction,
    operation_budget_bytes: u64,
) -> std::result::Result<JsValue, JsValue> {
    operation_actions(operation_handle, cursor, &[action], operation_budget_bytes)
}

fn operation_actions(
    operation_handle: u32,
    cursor: &mut AdapterOperationCursor,
    actions_to_issue: &[ReadBytesAction],
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
                        "Arrow action index exceeds u32",
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
        safe_integer_js(operation_revision, "Arrow operation revision")?,
    )?;
    let actions = Array::new();
    for (index, action) in actions_to_issue.iter().copied().enumerate() {
        actions.push(&read_action_value(
            action,
            u32::try_from(index).map_err(|_| {
                error_to_js(TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Arrow action index exceeds u32",
                ))
            })?,
        )?);
    }
    set(&result, "actions", actions.into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    Ok(result.into())
}

fn progressive_open_action(
    operation_handle: u32,
    cursor: &mut AdapterOperationCursor,
    actions: &[ReadBytesAction],
    source: ArrowSourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
    operation_budget_bytes: u64,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::from(operation_actions(
        operation_handle,
        cursor,
        actions,
        operation_budget_bytes,
    )?);
    set(&result, "kind", JsValue::from_str("progress"))?;
    set(&result, "operationKind", JsValue::from_str("open"))?;
    set_open_identity(&result, source, table_name, metadata)?;
    let bytes_scanned = actions.first().map_or(0, |action| action.offset);
    set_open_progress(&result, source, bytes_scanned, metadata, false)?;
    Ok(result.into())
}

fn complete_open(
    operation_handle: u32,
    operation_revision: u64,
    source: ArrowSourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
    bytes_scanned: Option<u64>,
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
        safe_integer_js(operation_revision, "Arrow operation revision")?,
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    set_open_identity(&result, source, table_name, metadata)?;
    if let Some(bytes_scanned) = bytes_scanned {
        set_open_progress(&result, source, bytes_scanned, metadata, true)?;
    }
    Ok(result.into())
}

fn read_action_value(
    action: ReadBytesAction,
    action_index: u32,
) -> std::result::Result<JsValue, JsValue> {
    let action_value = Object::new();
    set(&action_value, "kind", JsValue::from_str("read-bytes"))?;
    set(
        &action_value,
        "actionIndex",
        JsValue::from_f64(f64::from(action_index)),
    )?;
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
        safe_integer_js(operation_revision, "Arrow operation revision")?,
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
    let operation_revision = cursor.complete_revision().map_err(error_to_js)?;
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
        safe_integer_js(operation_revision, "Arrow operation revision")?,
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
            "Arrow result count exceeds usize",
        ))
    })?;
    if count > MAX_OPERATION_RANGES_PER_STEP {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Arrow operation supplied too many source results",
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
            .map_err(|_| invalid_operation_result(index, "actionIndex exceeds the u32 range"))?;
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
            .map_err(|_| invalid_operation_result(index, "result byte length exceeds u64"))?;
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
        TabularkError::new(ErrorCode::InvalidArgument, "invalid Arrow operation result")
            .with_detail("resultIndex", index)
            .with_detail("reason", reason),
    )
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

fn validate_incremental_source_length(source_length: u64) -> tabulark::Result<()> {
    if source_length > MAX_RANGE_SOURCE_BYTES {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC range source exceeds the exact 4 GiB-1 address limit",
        )
        .with_detail("sourceBytes", source_length)
        .with_detail("maxSourceBytes", MAX_RANGE_SOURCE_BYTES));
    }
    Ok(())
}

fn incremental_limits(memory_budget_bytes: usize) -> tabulark::Result<ArrowIpcLimits> {
    let mut limits = ArrowIpcLimits::from_memory_budget(memory_budget_bytes)?;
    // The encoded File stays behind a Worker-owned accessor and is never
    // retained in WASM. Keep decoded/output sublimits tied to the runtime budget while the
    // independent source-length ceiling follows the range address contract.
    limits.max_source_bytes = usize::try_from(MAX_RANGE_SOURCE_BYTES).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Arrow IPC range source limit exceeds the runtime address space",
        )
    })?;
    limits.validate_for_memory_budget(memory_budget_bytes)?;
    Ok(limits)
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

#[cfg(test)]
mod tests {
    use super::{MAX_RANGE_SOURCE_BYTES, incremental_limits, validate_incremental_source_length};

    #[test]
    fn incremental_limits_decouple_source_extent_from_wasm_memory() {
        let limits = incremental_limits(32 * 1024 * 1024).expect("incremental limits");
        assert_eq!(
            limits.max_source_bytes,
            usize::try_from(MAX_RANGE_SOURCE_BYTES).expect("range limit fits usize")
        );
        assert!(limits.max_decoded_bytes <= 32 * 1024 * 1024);
        validate_incremental_source_length(MAX_RANGE_SOURCE_BYTES)
            .expect("exact 4 GiB-1 range source");
        assert!(validate_incremental_source_length(MAX_RANGE_SOURCE_BYTES + 1).is_err());
    }
}
