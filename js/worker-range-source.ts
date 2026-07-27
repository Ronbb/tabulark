// This private bundle is loaded only after a RangeSource descriptor reaches
// the Worker. Local Blob/ArrayBuffer users never fetch or parse its broker,
// singleflight, or interval-LRU implementation.
export {
  RangeSourceAccessor,
  WorkerSourceBroker,
  validateRangeDescriptor,
} from "./worker/source-accessor.js";
