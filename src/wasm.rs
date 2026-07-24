//! Thin `wasm-bindgen` exports used by the dedicated Worker runtime.

use std::cell::RefCell;

use js_sys::{Array, Object, Reflect, Uint8Array, Uint32Array};
use serde::Serialize;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::csv::DelimitedOptions;
use crate::error::{ErrorCode, TabularkError};
use crate::model::{RangeRequest, TableBatch};
use crate::protocol::PROTOCOL_VERSION;
use crate::runtime::{
    BeginRangeResult, FeedRangeResult, RangeHandle, Runtime, RuntimeConfig, SourceHandle,
};

/// Low-level chunk-oriented runtime intended to live inside a module Worker.
///
/// The Worker retains the `Blob`, supplies 1 MiB-class slices, and transfers
/// the JavaScript-owned typed arrays returned by [`WasmRuntime::feed_range`].
#[wasm_bindgen]
pub struct WasmRuntime {
    inner: RefCell<Runtime>,
}

#[wasm_bindgen]
impl WasmRuntime {
    /// Creates a runtime from a camel-case [`RuntimeConfig`] JavaScript object.
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> std::result::Result<WasmRuntime, JsValue> {
        let config = if config.is_null() || config.is_undefined() {
            RuntimeConfig::default()
        } else {
            from_js(config)?
        };
        Ok(Self {
            inner: RefCell::new(Runtime::new(config).map_err(error_to_js)?),
        })
    }

    /// Returns the Worker protocol version implemented by this build.
    #[wasm_bindgen(js_name = protocolVersion)]
    pub fn protocol_version(&self) -> u32 {
        PROTOCOL_VERSION
    }

    /// Creates a progressive CSV/TSV source scanner.
    #[wasm_bindgen(js_name = openDelimited)]
    pub fn open_delimited(&self, options: JsValue) -> std::result::Result<JsValue, JsValue> {
        let options = if options.is_null() || options.is_undefined() {
            DelimitedOptions::default()
        } else {
            from_js(options)?
        };
        let handle = self
            .inner
            .borrow_mut()
            .open_delimited(options)
            .map_err(error_to_js)?;
        to_js(&serde_json::json!({"sourceHandle": handle.get()}))
    }

    /// Feeds the next contiguous source chunk into a scanner.
    #[wasm_bindgen(js_name = scanChunk)]
    pub fn scan_chunk(
        &self,
        source_handle: u32,
        absolute_offset: f64,
        bytes: Uint8Array,
        eof: bool,
    ) -> std::result::Result<JsValue, JsValue> {
        let offset = safe_integer(absolute_offset, "absoluteOffset")?;
        let update = self
            .inner
            .borrow_mut()
            .scan_chunk(
                SourceHandle::from_raw(source_handle),
                offset,
                bytes.to_vec().as_slice(),
                eof,
            )
            .map_err(error_to_js)?;
        to_js(&update)
    }

    /// Returns the current progressive metadata snapshot.
    #[wasm_bindgen(js_name = metadata)]
    pub fn metadata(&self, source_handle: u32) -> std::result::Result<JsValue, JsValue> {
        let metadata = self
            .inner
            .borrow()
            .metadata(SourceHandle::from_raw(source_handle))
            .map_err(error_to_js)?;
        to_js(&metadata)
    }

    /// Starts a range decoder and returns its checkpoint source plan.
    #[wasm_bindgen(js_name = beginRange)]
    pub fn begin_range(
        &self,
        source_handle: u32,
        request: JsValue,
    ) -> std::result::Result<JsValue, JsValue> {
        let request: RangeRequest = from_js(request)?;
        let result = self
            .inner
            .borrow_mut()
            .begin_range(SourceHandle::from_raw(source_handle), request)
            .map_err(error_to_js)?;
        begin_range_to_js(&result)
    }

    /// Feeds a planned range from the next contiguous source slice.
    #[wasm_bindgen(js_name = feedRange)]
    pub fn feed_range(
        &self,
        range_handle: u32,
        absolute_offset: f64,
        bytes: Uint8Array,
        eof: bool,
    ) -> std::result::Result<JsValue, JsValue> {
        let offset = safe_integer(absolute_offset, "absoluteOffset")?;
        let result = self
            .inner
            .borrow_mut()
            .feed_range(
                RangeHandle::from_raw(range_handle),
                offset,
                bytes.to_vec().as_slice(),
                eof,
            )
            .map_err(error_to_js)?;
        feed_range_to_js(&result)
    }

    /// Best-effort cancellation of a range decoder.
    #[wasm_bindgen(js_name = cancel)]
    pub fn cancel(&self, range_handle: u32) -> bool {
        self.inner
            .borrow_mut()
            .cancel(RangeHandle::from_raw(range_handle))
    }

    /// Idempotently closes one range decoder.
    #[wasm_bindgen(js_name = closeRange)]
    pub fn close_range(&self, range_handle: u32) -> bool {
        self.inner
            .borrow_mut()
            .close_range(RangeHandle::from_raw(range_handle))
    }

    /// Idempotently closes one source and its child ranges.
    #[wasm_bindgen(js_name = closeSource)]
    pub fn close_source(&self, source_handle: u32) -> bool {
        self.inner
            .borrow_mut()
            .close_source(SourceHandle::from_raw(source_handle))
    }

    /// Releases every handle owned by this runtime.
    #[wasm_bindgen(js_name = shutdown)]
    pub fn shutdown(&self) {
        self.inner.borrow_mut().shutdown();
    }
}

fn begin_range_to_js(result: &BeginRangeResult) -> std::result::Result<JsValue, JsValue> {
    let object = Object::new();
    set(
        &object,
        "rangeHandle",
        JsValue::from_f64(f64::from(result.range_handle.get())),
    )?;
    set(&object, "plan", to_js(&result.plan)?)?;
    if let Some(batch) = &result.batch {
        set(&object, "batch", batch_to_js(batch)?)?;
    }
    Ok(object.into())
}

fn feed_range_to_js(result: &FeedRangeResult) -> std::result::Result<JsValue, JsValue> {
    let object = Object::new();
    match result {
        FeedRangeResult::NeedMore {
            expected_offset,
            warnings,
        } => {
            set(&object, "status", JsValue::from_str("need-more"))?;
            set(
                &object,
                "expectedOffset",
                JsValue::from_f64(*expected_offset as f64),
            )?;
            set(&object, "warnings", to_js(warnings)?)?;
        }
        FeedRangeResult::Complete { batch, warnings } => {
            set(&object, "status", JsValue::from_str("complete"))?;
            set(&object, "batch", batch_to_js(batch)?)?;
            set(&object, "warnings", to_js(warnings)?)?;
        }
    }
    Ok(object.into())
}

fn batch_to_js(batch: &TableBatch) -> std::result::Result<JsValue, JsValue> {
    let object = Object::new();
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

    let columns = Array::new();
    for column in batch.columns() {
        let value = Object::new();
        set(&value, "columnId", JsValue::from_str(column.column_id()))?;
        set(&value, "data", Uint8Array::from(column.data()).into())?;
        set(
            &value,
            "offsets",
            Uint32Array::from(column.offsets()).into(),
        )?;
        set(
            &value,
            "validity",
            Uint8Array::from(column.validity()).into(),
        )?;
        columns.push(&value);
    }
    set(&object, "columns", columns.into())?;
    Ok(object.into())
}

fn set(object: &Object, key: &str, value: JsValue) -> std::result::Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value).map(|_| ())
}

fn safe_integer(value: f64, field: &str) -> std::result::Result<u64, JsValue> {
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
                "invalid WebAssembly method payload",
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
                "failed to serialize WebAssembly method result",
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
        .unwrap_or_else(|_| JsValue::from_str("Tabulark runtime failure"))
}
