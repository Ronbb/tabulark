import init, { WasmRuntime as ExcelWasmRuntime } from "/dist/wasm/excel/tabulark_excel.js";

export default init;

/** Test-only binding that keeps the real Excel runtime but constrains presentation output. */
export class WasmRuntime {
  constructor(config) {
    return new ExcelWasmRuntime({ ...config, maxBatchBytes: 512 });
  }
}
