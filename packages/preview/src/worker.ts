/// <reference lib="webworker" />
import { decodeText, parseStructured } from "./parse.js";
import { inspectImage } from "./image.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener("message", (event: MessageEvent) => {
  const request = event.data as { id: number; operation: string; format?: any; bytes?: ArrayBuffer; maxPixels?: number };
  try {
    if (!(request.bytes instanceof ArrayBuffer)) throw new Error("worker bytes are missing");
    const bytes = new Uint8Array(request.bytes);
    if (request.operation === "text") {
      const decoded = decodeText(bytes);
      const value = request.format === "json" || request.format === "jsonl" || request.format === "yaml" || request.format === "xml" || request.format === "toml" ? parseStructured(request.format, decoded.text) : undefined;
      scope.postMessage({ id: request.id, ok: true, decoded, value });
    } else if (request.operation === "image") {
      scope.postMessage({ id: request.id, ok: true, info: inspectImage(request.format, bytes, request.maxPixels ?? 32_000_000) });
    } else throw new Error("unknown preview worker operation");
  } catch (error) { scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? { name: error.name, message: error.message, code: (error as { code?: unknown }).code, details: (error as { details?: unknown }).details } : { message: String(error) } }); }
});
