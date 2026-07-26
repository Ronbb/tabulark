export { type ArrowIpcAdapterOptions, type ArrowIpcContainer } from "./adapters.js";

import { createArrowIpcAdapter } from "./adapters.js";

/** Opens Apache Arrow IPC File or Stream input through the lazy official Arrow artifact. */
export const arrowIpcAdapter = createArrowIpcAdapter();
