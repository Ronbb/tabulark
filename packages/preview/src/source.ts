import { cancelled, PreviewError, resourceLimit } from "./errors.js";
import type { PreviewSource, RangeSource, RangeSourceReader, RangeSourceSnapshot } from "./types.js";

export const MAX_PREVIEW_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;
export interface OpenedSource {
  readonly size: number; readonly name?: string; readonly snapshot: RangeSourceSnapshot; readonly remoteRange: boolean;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}
export function isRangeSource(value: unknown): value is RangeSource {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "range" && typeof (value as { open?: unknown }).open === "function";
}
export async function openSource(source: PreviewSource, limits: { maxSourceBytes: number; maxInputBytes: number; maxRangeConcurrency: number }, signal?: AbortSignal): Promise<OpenedSource> {
  if (signal?.aborted) throw cancelled();
  if (isRangeSource(source)) {
    const controller = linkedController(signal);
    let reader: RangeSourceReader;
    try { reader = await source.open({ signal: controller.signal, maxSourceBytes: limits.maxSourceBytes, maxStagingBytes: limits.maxInputBytes }); }
    catch (error) { if (controller.signal.aborted) throw cancelled(); throw error; }
    validateReader(reader, limits);
    const snapshot = Object.freeze({ ...reader.snapshot });
    let closed = false;
    return {
      size: reader.size, ...(source.name === undefined ? {} : { name: source.name }), snapshot, remoteRange: true,
      async read(offset, length, operationSignal) {
        if (closed) throw new PreviewError("HANDLE_CLOSED", "The source reader is closed");
        validateRange(offset, length, reader.size);
        const op = linkedController(operationSignal);
        const value = await reader.read({ offset, length }, { signal: op.signal });
        const bytes = copyBytes(value);
        if (bytes.byteLength !== length) throw new PreviewError("SOURCE_CHANGED", "The range source returned a short or long read", { details: { offset, expected: length, actual: bytes.byteLength } });
        if (reader.snapshot.id !== snapshot.id || reader.snapshot.strength !== snapshot.strength) throw new PreviewError("SOURCE_CHANGED", "The range source snapshot changed while previewing");
        return bytes;
      },
      async close() { if (closed) return; closed = true; controller.abort(); await reader.close(); },
    };
  }
  const blob = toBlob(source);
  if (blob.size > limits.maxSourceBytes) throw resourceLimit("source-bytes", blob.size, limits.maxSourceBytes);
  let closed = false;
  return {
    size: blob.size,
    ...(typeof File !== "undefined" && blob instanceof File ? { name: blob.name } : {}),
    snapshot: Object.freeze({ id: `local:${blob.size}:${cryptoId()}`, strength: "strong" as const }), remoteRange: false,
    async read(offset, length, operationSignal) {
      if (closed) throw new PreviewError("HANDLE_CLOSED", "The source reader is closed");
      if (operationSignal?.aborted) throw cancelled();
      validateRange(offset, length, blob.size);
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      if (operationSignal?.aborted) throw cancelled();
      return bytes;
    },
    async close() { closed = true; },
  };
}
function toBlob(source: Exclude<PreviewSource, RangeSource>): Blob {
  if (typeof Blob !== "undefined" && source instanceof Blob) return source;
  if (source instanceof ArrayBuffer) return new Blob([source.slice(0)]);
  if (ArrayBuffer.isView(source)) return new Blob([new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()]);
  throw new TypeError("source must be a Blob, File, ArrayBuffer, ArrayBufferView, or RangeSource");
}
function validateReader(reader: RangeSourceReader, limits: { maxSourceBytes: number; maxRangeConcurrency: number }): void {
  if (typeof reader !== "object" || reader === null || !Number.isSafeInteger(reader.size) || reader.size < 0 || reader.size > limits.maxSourceBytes || reader.size > MAX_PREVIEW_SOURCE_BYTES) throw new RangeError("RangeSource reader size is invalid");
  if (!reader.snapshot || typeof reader.snapshot.id !== "string" || reader.snapshot.id.length === 0 || reader.snapshot.id.length > 256 || !["strong", "weak"].includes(reader.snapshot.strength)) throw new RangeError("RangeSource snapshot is invalid");
  if (typeof reader.read !== "function" || typeof reader.close !== "function") throw new TypeError("RangeSource reader is invalid");
  if (reader.maxConcurrency !== undefined && (!Number.isSafeInteger(reader.maxConcurrency) || reader.maxConcurrency < 1 || reader.maxConcurrency > limits.maxRangeConcurrency)) throw new RangeError("RangeSource concurrency exceeds the preview limit");
}
function validateRange(offset: number, length: number, size: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > size || length > size - offset) throw new RangeError("byte range is outside the source");
}
function copyBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (!ArrayBuffer.isView(value)) throw new TypeError("RangeSource returned a non-buffer value");
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}
function linkedController(signal?: AbortSignal): AbortController { const controller = new AbortController(); signal?.addEventListener("abort", () => controller.abort(), { once: true }); return controller; }
function cryptoId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }
