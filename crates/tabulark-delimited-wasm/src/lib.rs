//! Thin, publish-disabled WebAssembly wrapper for the delimited adapter.

use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

/// Creates the core delimited runtime from the dedicated artifact.
///
/// Referencing the exported core type from this small factory keeps the
/// existing `WasmRuntime` ABI intact without compiling a second forwarding
/// class into the wrapper.
#[wasm_bindgen(js_name = createRuntime)]
pub fn create_runtime(config: JsValue) -> std::result::Result<tabulark::WasmRuntime, JsValue> {
    tabulark::WasmRuntime::new(config)
}
