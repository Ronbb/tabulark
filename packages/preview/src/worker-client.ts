import { PreviewError } from "./errors.js";
import { decodeText, parseStructured } from "./parse.js";
import { inspectImage } from "./image.js";
import type { PreviewFormat } from "./types.js";

interface WorkerResult { readonly decoded?: ReturnType<typeof decodeText>; readonly value?: unknown; readonly info?: ReturnType<typeof inspectImage> }
export async function inspectInWorker(operation: "text" | "image", format: PreviewFormat, bytes: Uint8Array, maxPixels: number, signal?: AbortSignal): Promise<WorkerResult> {
  if (typeof Worker === "undefined") return operation === "text" ? directText(format, bytes) : { info: inspectImage(format, bytes, maxPixels) };
  if (signal?.aborted) throw new PreviewError("CANCELLED", "The preview operation was cancelled");
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "tabulark-preview" });
  const id = 1;
  return new Promise<WorkerResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); worker.onmessage = null; worker.onerror = null; worker.terminate(); callback(); };
    const abort = (): void => finish(() => reject(new PreviewError("CANCELLED", "The preview operation was cancelled")));
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; error?: { code?: string; message?: string; details?: Record<string, unknown> }; decoded?: ReturnType<typeof decodeText>; value?: unknown; info?: ReturnType<typeof inspectImage> }>) => { if (event.data.id !== id) return; if (!event.data.ok) finish(() => reject(new PreviewError((event.data.error?.code as "PARSE_FAILED") ?? "PARSE_FAILED", event.data.error?.message ?? "Preview Worker failed", event.data.error?.details === undefined ? {} : { details: event.data.error.details }))); else finish(() => resolve({ ...(event.data.decoded === undefined ? {} : { decoded: event.data.decoded }), ...(Object.hasOwn(event.data, "value") ? { value: event.data.value } : {}), ...(event.data.info === undefined ? {} : { info: event.data.info }) })); };
    worker.onerror = (event) => finish(() => reject(new PreviewError("RUNTIME_FAILURE", event.message || "Preview Worker stopped")));
    signal?.addEventListener("abort", abort, { once: true });
    const payload = bytes.slice().buffer; worker.postMessage({ id, operation, format, bytes: payload, maxPixels }, [payload]);
  });
}
function directText(format: PreviewFormat, bytes: Uint8Array): WorkerResult { const decoded = decodeText(bytes); return { decoded, ...(format === "json" || format === "jsonl" || format === "yaml" || format === "xml" || format === "toml" ? { value: parseStructured(format, decoded.text) } : {}) }; }
