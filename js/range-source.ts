/**
 * Bounded, repeatable byte-range sources.
 *
 * A RangeSource is intentionally a very small host-side capability.  The
 * worker never receives the implementation (or a URL); it is given an opaque
 * reader handle by the client and asks the host for bounded byte ranges.
 */

/** The largest addressable source (2^32 - 1 bytes). */
export const MAX_RANGE_SOURCE_BYTES = 0xffff_ffff;

/** A half-open byte interval [offset, offset + length). */
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** A stable identity for one opened view of a source. */
export interface RangeSourceSnapshot {
  readonly id: string;
  readonly strength: "strong" | "weak";
}

/** Options supplied to every reader operation. */
export interface RangeSourceReadOptions {
  readonly signal: AbortSignal;
}

/** A reader returned by a RangeSource.open() call. */
export interface RangeSourceReader {
  /** Exact source size in bytes. */
  readonly size: number;
  /** Validator captured while opening the source. */
  readonly snapshot: RangeSourceSnapshot;
  /** Maximum number of provider reads that may run concurrently. Defaults to 1. */
  readonly maxConcurrency?: number;
  /** Reads exactly range.length bytes, or rejects. */
  read(
    range: ByteRange,
    options: RangeSourceReadOptions,
  ): Promise<ArrayBuffer | ArrayBufferView>;
  /** Releases all resources. Calling close more than once is harmless. */
  close(): Promise<void> | void;
}

/** Open-time limits owned by the engine. */
export interface RangeSourceOpenOptions {
  readonly signal: AbortSignal;
  readonly maxSourceBytes: number;
  readonly maxStagingBytes: number;
}

/** A repeatably openable source addressed by bounded byte ranges. */
export interface RangeSource {
  readonly kind: "range";
  readonly name?: string;
  open(options: RangeSourceOpenOptions): Promise<RangeSourceReader>;
}

/** Runtime check used at the public engine boundary. */
export function isRangeSource(value: unknown): value is RangeSource {
  if (typeof value !== "object" || value === null) return false;
  try {
    const candidate = value as { kind?: unknown; open?: unknown };
    return candidate.kind === "range" && typeof candidate.open === "function";
  } catch {
    return false;
  }
}

/**
 * Validates a byte range without coercing values.  Keeping this check in one
 * place prevents unsafe floating-point arithmetic at both HTTP and Worker
 * boundaries.
 */
export function validateByteRange(
  range: unknown,
  size: number,
): asserts range is ByteRange {
  if (!isSafeNonNegativeInteger(size) || size > MAX_RANGE_SOURCE_BYTES) {
    throw new RangeError("source size is outside the supported range");
  }
  if (typeof range !== "object" || range === null) {
    throw new RangeError("range must be an object");
  }
  const candidate = range as { offset?: unknown; length?: unknown };
  let offset: unknown;
  let length: unknown;
  try {
    offset = candidate.offset;
    length = candidate.length;
  } catch {
    throw new RangeError("range is outside the source");
  }
  if (!isSafeNonNegativeInteger(offset)
    || !isSafeNonNegativeInteger(length)
    || offset > MAX_RANGE_SOURCE_BYTES
    || length > MAX_RANGE_SOURCE_BYTES
    || offset + length > size) {
    throw new RangeError("range is outside the source");
  }
}

/** Validates and freezes a reader snapshot. */
export function normalizeRangeSourceSnapshot(value: unknown): RangeSourceSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new RangeError("reader snapshot must be an object");
  }
  const candidate = value as { id?: unknown; strength?: unknown };
  if (typeof candidate.id !== "string"
    || candidate.id.length === 0
    || candidate.id.length > 256
    || candidate.strength !== "strong" && candidate.strength !== "weak") {
    throw new RangeError("reader snapshot is invalid");
  }
  return Object.freeze({ id: candidate.id, strength: candidate.strength });
}

/** Validates a reader object returned by an adapter/broker. */
export function validateRangeSourceReader(value: unknown): value is RangeSourceReader {
  if (typeof value !== "object" || value === null) return false;
  try {
    const candidate = value as {
      size?: unknown;
      snapshot?: unknown;
      maxConcurrency?: unknown;
      read?: unknown;
      close?: unknown;
    };
    if (!isSafeNonNegativeInteger(candidate.size)
      || candidate.size > MAX_RANGE_SOURCE_BYTES
      || !isValidSnapshot(candidate.snapshot)
      || typeof candidate.read !== "function"
      || typeof candidate.close !== "function") {
      return false;
    }
    return candidate.maxConcurrency === undefined
      || (isSafeNonNegativeInteger(candidate.maxConcurrency)
        && candidate.maxConcurrency >= 1
        && candidate.maxConcurrency <= 4);
  } catch {
    // A hostile proxy/getter is an invalid reader, not an unstructured host
    // exception that should escape the public open() contract.
    return false;
  }
}

/** Converts an ArrayBuffer or view to a fresh, exact-length ArrayBuffer. */
export function copyRangeBytes(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (!ArrayBuffer.isView(value)) {
    throw new RangeError("reader returned a non-buffer value");
  }
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Returns whether a value is a safe non-negative integer. */
export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidSnapshot(value: unknown): value is RangeSourceSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; strength?: unknown };
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= 256
    && (candidate.strength === "strong" || candidate.strength === "weak");
}
