import { ProtocolFault } from "./worker-errors.js";
import type { SourceAccessor, SourceReadOptions } from "./source-accessor.js";

/** Local Blob/File accessor kept in the eager Worker path. */
export class BlobSourceAccessor implements SourceAccessor {
  readonly kind = "blob" as const;
  readonly size: number;
  readonly #blob: Blob;
  #closed = false;

  constructor(blob: Blob) {
    this.#blob = blob;
    this.size = blob.size;
  }

  async read(offset: number, length: number, options: SourceReadOptions = {}): Promise<ArrayBuffer> {
    if (this.#closed) {
      options.onSettled?.();
      throw new ProtocolFault("HANDLE_CLOSED", "The source is closed");
    }
    const end = checkedEnd(offset, length, this.size);
    if (end === undefined) {
      options.onSettled?.();
      throw new ProtocolFault("RANGE_UNSUPPORTED", "The requested source range is outside the source");
    }
    let bounded: Blob;
    try {
      bounded = this.#blob.slice(offset, end);
      if (!bounded || (bounded.size !== undefined && bounded.size !== length)) {
        throw new ProtocolFault("RUNTIME_FAILURE", "Blob slice returned an invalid bounded length");
      }
    } catch (error) {
      options.onSettled?.();
      throw error instanceof ProtocolFault
        ? error
        : new ProtocolFault("SOURCE_UNAVAILABLE", "The local source could not be sliced", true, undefined, error);
    }
    const operation = readBlob(bounded, length).finally(() => options.onSettled?.());
    const result = options.cancellation === undefined
      ? await operation
      : await raceCancellation(operation, options.cancellation);
    options.onProviderRead?.(result.byteLength);
    return result;
  }

  close(): void {
    this.#closed = true;
  }
}

async function readBlob(blob: Blob, expectedLength: number): Promise<ArrayBuffer> {
  try {
    const method = (blob as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
    const result = typeof method === "function"
      ? await method.call(blob)
      : await readBlobStream(blob, expectedLength);
    return normalizeExactBytes(result, expectedLength);
  } catch (error) {
    if (error instanceof ProtocolFault) throw error;
    throw new ProtocolFault("SOURCE_UNAVAILABLE", "The local source could not be read", true, undefined, error);
  }
}

async function readBlobStream(blob: Blob, expectedLength: number): Promise<ArrayBuffer> {
  if (typeof blob.stream !== "function") {
    throw new TypeError("Blob slices must provide stream() or arrayBuffer()");
  }
  const output = new Uint8Array(expectedLength);
  const reader = blob.stream().getReader();
  let written = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array
        ? next.value
        : new Uint8Array(next.value as ArrayBufferLike);
      if (chunk.byteLength > expectedLength - written) {
        throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned too many bytes");
      }
      output.set(chunk, written);
      written += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (written !== expectedLength) {
    throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned too few bytes");
  }
  return output.buffer;
}

function normalizeExactBytes(value: unknown, expectedLength: number): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength !== expectedLength) {
      throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned an invalid byte length");
    }
    return value;
  }
  if (ArrayBuffer.isView(value) && value.byteLength === expectedLength) {
    const bytes = new Uint8Array(expectedLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return bytes.buffer;
  }
  throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned an invalid byte buffer");
}

function checkedEnd(offset: number, length: number, size: number): number | undefined {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || !Number.isSafeInteger(size) || size < 0
    || offset > size || length > size - offset) return undefined;
  return offset + length;
}

function raceCancellation<T>(operation: Promise<T>, cancellation: Promise<void>): Promise<T> {
  return Promise.race([
    operation,
    cancellation.then<T>(() => {
      throw new ProtocolFault("CANCELLED", "The source read was cancelled");
    }),
  ]);
}
