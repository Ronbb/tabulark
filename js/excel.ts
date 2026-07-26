export { type ExcelAdapterOptions, type ExcelFormat } from "./adapters.js";

import { createExcelAdapter } from "./adapters.js";

/** Opens BIFF8 XLS or OOXML XLSX input through the lazy official Excel artifact. */
export const excelAdapter = createExcelAdapter();
