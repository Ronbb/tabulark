/**
 * Host-side source policy shared by the stable client and its Worker.
 *
 * This is deliberately a binary constant (rather than a decimal "2G" value):
 * the large-source contract is exactly 2 * 1024^3 bytes.  Keeping the value
 * in one module prevents the client and Worker from drifting at the boundary.
 */
export const MAX_LARGE_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

// RangeSource is kept in a small standalone module so the stable client and
// the optional HTTP entrypoint share one structural contract without pulling
// HTTP/fetch code into the core bundle.
export {
  MAX_RANGE_SOURCE_BYTES,
  isRangeSource,
  validateByteRange,
  validateRangeSourceReader,
  copyRangeBytes,
} from "./range-source.js";
export type {
  ByteRange,
  RangeSource,
  RangeSourceOpenOptions,
  RangeSourceReader,
  RangeSourceReadOptions,
  RangeSourceSnapshot,
} from "./range-source.js";

/** Selects the bounded default path or the large local-Blob path. */
export type SourceMode = "auto" | "large";

export function isSourceMode(value: unknown): value is SourceMode {
  return value === "auto" || value === "large";
}
