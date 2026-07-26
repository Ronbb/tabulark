export { type ParquetAdapterOptions } from "./adapters.js";

import { createParquetAdapter } from "./adapters.js";

/** Opens Apache Parquet input through the lazy official Parquet WASM artifact. */
export const parquetAdapter = createParquetAdapter();
