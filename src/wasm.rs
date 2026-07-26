//! Adapter-ABI-v3 WebAssembly exports for the dedicated delimited artifact.

use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::Serialize;
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};

use crate::csv::{CsvDiagnostic, DelimitedOptions};
use crate::error::{ErrorCode, TabularkError};
use crate::model::{RangeRequest, TableMetadata, TypedTableBatch};
use crate::protocol::{
    ADAPTER_API_VERSION, AdapterAction, AdapterActionResult, AdapterOperationCursor,
    BATCH_LAYOUT_VERSION, DELIMITED_ADAPTER_ID, MAX_OPERATION_RANGES_PER_STEP, PROTOCOL_VERSION,
};
use crate::resource::{ResourceCategory, ResourceLedger};
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

struct TrackedOperation {
    cursor: AdapterOperationCursor,
    pending: PendingOperation,
}

struct State {
    runtime: Runtime,
    chunk_bytes: u64,
    operation_budget_bytes: u64,
    ledger: ResourceLedger,
    next_operation: u32,
    next_table: u32,
    operations: HashMap<u32, TrackedOperation>,
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
                matches!(&operation.pending, PendingOperation::Read(read) if read.table == table)
                    .then_some(*handle)
            })
            .collect::<Vec<_>>();
        for handle in handles {
            if let Some(operation) = self.operations.remove(&handle) {
                self.cancel_pending(operation.pending);
            }
        }
    }

    fn remove_operations_for_source(&mut self, source: SourceHandle) {
        let handles = self
            .operations
            .iter()
            .filter_map(|(handle, operation)| match &operation.pending {
                PendingOperation::Open(open) if open.source == source => Some(*handle),
                PendingOperation::Read(read) if read.source == source => Some(*handle),
                _ => None,
            })
            .collect::<Vec<_>>();
        for handle in handles {
            if let Some(operation) = self.operations.remove(&handle) {
                self.cancel_pending(operation.pending);
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
        let operation_budget_bytes = u64::try_from(config.memory_budget_bytes).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "configured delimited operation budget exceeds u64",
            ))
        })?;
        Ok(Self {
            state: RefCell::new(State {
                runtime: Runtime::new(config).map_err(error_to_js)?,
                chunk_bytes,
                operation_budget_bytes,
                ledger: ResourceLedger::new(operation_budget_bytes).map_err(error_to_js)?,
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

    /// Returns official adapter ABI version three.
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

    /// Returns the private adapter-owned resource ledger snapshot.
    #[wasm_bindgen(js_name = resourceSnapshot)]
    pub fn resource_snapshot(&self) -> std::result::Result<JsValue, JsValue> {
        let wasm_memory_pages = current_wasm_memory_pages();
        let mut state = self.state.borrow_mut();
        let persistent = u64::try_from(state.runtime.retained_bytes()).map_err(|_| {
            error_to_js(TabularkError::new(
                ErrorCode::ResourceLimit,
                "delimited retained-byte estimate exceeds u64",
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
                    "delimited active-operation estimate overflows",
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
        let mut cursor = AdapterOperationCursor::new();
        let result = match open_operation_action(
            operation,
            &mut cursor,
            action,
            OpenProgress {
                source,
                table_name: &table_name,
                metadata: &metadata,
                warnings: &[],
                bytes_scanned: 0,
            },
            state.operation_budget_bytes,
        ) {
            Ok(result) => result,
            Err(error) => {
                state.runtime.close_source(source);
                return Err(error);
            }
        };
        state.source_lengths.insert(source, source_length);
        state.operations.insert(
            operation,
            TrackedOperation {
                cursor,
                pending: PendingOperation::Open(pending),
            },
        );
        Ok(result)
    }

    /// Supplies a complete, revision-matched result set and advances an open
    /// or range-read operation.
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
                "delimited operation handle is closed",
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
            .expect("validated operation remains registered");
        if results.len() != 1 {
            state
                .operations
                .insert(operation_handle, TrackedOperation { cursor, pending });
            return Err(error_to_js(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "delimited operations issue exactly one source range per step",
            )));
        }
        let result = results.pop().expect("one validated result");
        let absolute_offset = result.descriptor.offset;
        let eof = result.descriptor.eof;
        let owned = result.bytes;
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
                    let operation_revision = cursor.complete_revision().map_err(error_to_js)?;
                    match complete_open(
                        operation_handle,
                        operation_revision,
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
                        &mut cursor,
                        action,
                        OpenProgress {
                            source: pending.source,
                            table_name: &pending.table_name,
                            metadata: &update.metadata,
                            warnings: &update.warnings,
                            bytes_scanned: pending.next_offset,
                        },
                        state.operation_budget_bytes,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            state.cancel_pending(PendingOperation::Open(pending));
                            return Err(error);
                        }
                    };
                    state.operations.insert(
                        operation_handle,
                        TrackedOperation {
                            cursor,
                            pending: PendingOperation::Open(pending),
                        },
                    );
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
                        Err(error) => {
                            state.runtime.cancel(pending.range);
                            return Err(error_to_js(error));
                        }
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
                        let result = match operation_action(
                            operation_handle,
                            &mut cursor,
                            action,
                            state.operation_budget_bytes,
                        ) {
                            Ok(result) => result,
                            Err(error) => {
                                state.runtime.cancel(pending.range);
                                return Err(error);
                            }
                        };
                        state.operations.insert(
                            operation_handle,
                            TrackedOperation {
                                cursor,
                                pending: PendingOperation::Read(pending),
                            },
                        );
                        Ok(result)
                    }
                    FeedRangeResult::Complete { batch, warnings } => {
                        let batch = batch.into_typed().map_err(error_to_js)?;
                        let operation_revision = cursor.complete_revision().map_err(error_to_js)?;
                        complete_batch(operation_handle, operation_revision, &batch, &warnings)
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

    /// Starts and synchronously completes a metadata operation.
    #[wasm_bindgen(js_name = beginMetadata)]
    pub fn begin_metadata(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let metadata = self.metadata(table_handle)?;
        let mut state = self.state.borrow_mut();
        let operation = state.allocate_operation()?;
        complete_value(operation, "metadata", "metadata", metadata)
    }

    /// Returns no static presentation for delimited text tables.
    pub fn presentation(&self, table_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let state = self.state.borrow();
        if !state.tables.contains_key(&table_handle) {
            return Err(error_to_js(TabularkError::new(
                ErrorCode::HandleClosed,
                "delimited table handle is closed",
            )));
        }
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

    /// Returns no range presentation for delimited text tables.
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
            let operation = state.allocate_operation()?;
            let mut cursor = AdapterOperationCursor::new();
            let operation_revision = cursor.complete_revision().map_err(error_to_js)?;
            let batch = batch.into_typed().map_err(error_to_js)?;
            return complete_batch(operation, operation_revision, &batch, &[]);
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
        let mut cursor = AdapterOperationCursor::new();
        let result =
            match operation_action(operation, &mut cursor, action, state.operation_budget_bytes) {
                Ok(result) => result,
                Err(error) => {
                    state.runtime.cancel(start.range_handle);
                    return Err(error);
                }
            };
        state.operations.insert(
            operation,
            TrackedOperation {
                cursor,
                pending: PendingOperation::Read(PendingRead {
                    source,
                    source_length,
                    next_offset,
                    range: start.range_handle,
                    table: table_handle,
                }),
            },
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
        state.cancel_pending(operation.pending);
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
        state.ledger.release_all();
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
    cursor: &mut AdapterOperationCursor,
    action: ReadAction,
    operation_budget_bytes: u64,
) -> std::result::Result<JsValue, JsValue> {
    let operation_revision = cursor
        .issue(
            vec![AdapterAction::indexed_read_bytes(
                0,
                action.offset,
                action.length,
            )],
            operation_budget_bytes,
        )
        .map_err(error_to_js)?;
    let action_value = Object::new();
    set(&action_value, "kind", JsValue::from_str("read-bytes"))?;
    set(&action_value, "actionIndex", JsValue::from_f64(0.0))?;
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
    set(&result, "kind", JsValue::from_str("pending"))?;
    set(
        &result,
        "operationHandle",
        JsValue::from_f64(f64::from(operation_handle)),
    )?;
    set(
        &result,
        "operationRevision",
        JsValue::from_f64(operation_revision as f64),
    )?;
    let actions = Array::new();
    actions.push(&action_value);
    set(&result, "actions", actions.into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    Ok(result.into())
}

/// Adds the progressive source state carried by a pending delimited-open action.
///
/// A Worker can hand the pending action to a background scan after its initial
/// preview prefix is available, while range reads retain the common
/// `read-bytes` action contract unchanged.
struct OpenProgress<'a> {
    source: SourceHandle,
    table_name: &'a str,
    metadata: &'a TableMetadata,
    warnings: &'a [CsvDiagnostic],
    bytes_scanned: u64,
}

fn open_operation_action(
    operation_handle: u32,
    cursor: &mut AdapterOperationCursor,
    action: ReadAction,
    progress: OpenProgress<'_>,
    operation_budget_bytes: u64,
) -> std::result::Result<JsValue, JsValue> {
    let result = Object::from(operation_action(
        operation_handle,
        cursor,
        action,
        operation_budget_bytes,
    )?);
    set(&result, "kind", JsValue::from_str("progress"))?;
    set(&result, "operationKind", JsValue::from_str("open"))?;
    set(
        &result,
        "sourceHandle",
        JsValue::from_f64(f64::from(progress.source.get())),
    )?;
    set(&result, "metadata", to_js(progress.metadata)?)?;
    set(
        &result,
        "tables",
        table_descriptors(progress.table_name)?.into(),
    )?;
    set(
        &result,
        "progress",
        progress_value(
            progress.source,
            progress.metadata,
            progress.bytes_scanned,
            false,
        )?,
    )?;
    if !progress.warnings.is_empty() {
        set(&result, "warnings", to_js(progress.warnings)?)?;
    }
    Ok(result.into())
}

fn complete_open(
    operation_handle: u32,
    operation_revision: u64,
    source: SourceHandle,
    table_name: &str,
    metadata: &TableMetadata,
    warnings: &[CsvDiagnostic],
    bytes_scanned: u64,
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
        JsValue::from_f64(operation_revision as f64),
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
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
    operation_handle: u32,
    operation_revision: u64,
    batch: &TypedTableBatch,
    warnings: &[CsvDiagnostic],
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
        JsValue::from_f64(operation_revision as f64),
    )?;
    set(&result, "actions", Array::new().into())?;
    set(&result, "cooperativeYield", JsValue::from_bool(false))?;
    set(&result, "batch", batch_to_js(batch)?)?;
    if !warnings.is_empty() {
        set(&result, "warnings", to_js(warnings)?)?;
    }
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
        JsValue::from_f64(operation_revision as f64),
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
            "delimited result count exceeds usize",
        ))
    })?;
    if count > MAX_OPERATION_RANGES_PER_STEP {
        return Err(error_to_js(
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "delimited operation supplied too many source results",
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
        TabularkError::new(
            ErrorCode::InvalidArgument,
            "invalid delimited operation result",
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
