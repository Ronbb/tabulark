/// <reference lib="webworker" />

import { PDFiumLibrary } from "@hyzyla/pdfium";
import type { PDFiumDocument } from "@hyzyla/pdfium";
import { DOCUMENT_PROTOCOL } from "./protocol.js";
import type { DocumentRequest, DocumentResponseResult, DocumentWorkerMessage, WorkerLimits } from "./protocol.js";
import type { DocumentErrorCode, DocumentPageInfo, RenderedDocumentPage } from "./types.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let library: Awaited<ReturnType<typeof PDFiumLibrary.init>> | undefined;
let documentHandle: PDFiumDocument | undefined;
let activeSession = "";
let pageCount = 0;
let limits: WorkerLimits | undefined;
const cancelled = new Set<number>();

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isRequest(event.data)) return;
  void dispatch(event.data);
});

async function dispatch(request: DocumentRequest): Promise<void> {
  try {
    let result: DocumentResponseResult;
    switch (request.operation) {
      case "hello":
        result = { operation: "hello", protocol: DOCUMENT_PROTOCOL };
        break;
      case "open":
        result = await open(request);
        break;
      case "pageInfo":
        result = { operation: "pageInfo", page: pageInfo(request.sessionId, request.pageIndex) };
        break;
      case "renderPage":
        result = { operation: "renderPage", page: await renderPage(request) };
        break;
      case "cancel":
        cancelled.add(request.targetRequestId);
        result = { operation: "cancel" };
        break;
      case "close":
        closeDocument(request.sessionId);
        result = { operation: "close" };
        break;
      case "shutdown":
        destroyAll();
        result = { operation: "shutdown" };
        break;
    }
    if (cancelled.delete(request.requestId)) throw workerError("CANCELLED", "The page request was cancelled");
    respond(request, result);
  } catch (error) {
    fail(request, normalizeError(error, request.operation));
  }
}

async function open(request: Extract<DocumentRequest, { operation: "open" }>): Promise<DocumentResponseResult> {
  if (request.format !== "pdf") throw workerError("UNSUPPORTED_FORMAT", "The PDF Worker only accepts PDF sources");
  if (documentHandle !== undefined) throw workerError("RUNTIME_FAILURE", "This Worker already owns a document");
  validateLimits(request.limits, request.bytes.byteLength);
  limits = request.limits;
  const wasmUrl = resolveAsset("pdfium.wasm", request.assetBaseUrl);
  try {
    library = await PDFiumLibrary.init({ wasmUrl });
    documentHandle = await library.loadDocument(new Uint8Array(request.bytes));
    activeSession = request.sessionId;
    pageCount = documentHandle.getPageCount();
    if (!Number.isSafeInteger(pageCount) || pageCount <= 0) throw workerError("PARSE_FAILED", "The PDF contains no pages");
    if (pageCount > request.limits.maxPages) throw limit("pages", pageCount, request.limits.maxPages);
    return {
      operation: "open",
      pageCount,
      capabilities: {
        pagination: "source-pdf",
        localOnly: true,
        textSelection: false,
        search: false,
        print: false,
        exportImages: false,
      },
    };
  } catch (error) {
    destroyAll();
    throw normalizePdfOpenError(error);
  }
}

function pageInfo(sessionId: string, pageIndex: number): DocumentPageInfo {
  assertPage(sessionId, pageIndex);
  const page = documentHandle!.getPage(pageIndex);
  try {
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const rotationQuarterTurns = internalRotation(page);
    return {
      pageIndex,
      width: originalWidth,
      height: originalHeight,
      rotation: ([0, 90, 180, 270] as const)[rotationQuarterTurns] ?? 0,
    };
  } finally {
    internalClosePage(page);
  }
}

async function renderPage(
  request: Extract<DocumentRequest, { operation: "renderPage" }>,
): Promise<RenderedDocumentPage> {
  assertPage(request.sessionId, request.pageIndex);
  if (!Number.isSafeInteger(request.pixelWidth) || request.pixelWidth <= 0) {
    throw workerError("RENDER_FAILED", "The requested page width is invalid");
  }
  const info = pageInfo(request.sessionId, request.pageIndex);
  const height = Math.max(1, Math.round(request.pixelWidth * info.height / info.width));
  const pixels = request.pixelWidth * height;
  if (pixels > limits!.maxPagePixels) throw limit("page-pixels", pixels, limits!.maxPagePixels);
  try {
    const page = documentHandle!.getPage(request.pageIndex);
    const rendered = await page.render({
      width: request.pixelWidth,
      height,
      colorSpace: "BGRA",
      transparent: false,
      render: async ({ data }) => data,
    });
    const buffer = exactBuffer(rendered.data);
    return {
      pageIndex: request.pageIndex,
      width: rendered.width,
      height: rendered.height,
      stride: rendered.width * 4,
      colorSpace: "srgb",
      pixels: buffer,
    };
  } catch (error) {
    throw workerError("RENDER_FAILED", "PDFium could not render the requested page", error);
  }
}

function closeDocument(sessionId: string): void {
  if (activeSession !== "" && activeSession !== sessionId) return;
  destroyAll();
}

function destroyAll(): void {
  try { documentHandle?.destroy(); } catch { /* best effort at the hard boundary */ }
  documentHandle = undefined;
  try { library?.destroy(); } catch { /* Worker termination follows */ }
  library = undefined;
  activeSession = "";
  pageCount = 0;
  limits = undefined;
  cancelled.clear();
}

function assertPage(sessionId: string, pageIndex: number): void {
  if (documentHandle === undefined || sessionId !== activeSession) throw workerError("HANDLE_CLOSED", "The PDF session is closed");
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
    throw workerError("RENDER_FAILED", "The requested PDF page is outside the document");
  }
}

function respond(request: DocumentRequest, result: DocumentResponseResult): void {
  const message: DocumentWorkerMessage = {
    protocol: DOCUMENT_PROTOCOL,
    kind: "response",
    requestId: request.requestId,
    generation: request.generation,
    ok: true,
    result,
  };
  const transfer = result.operation === "renderPage" ? [result.page.pixels] : [];
  scope.postMessage(message, transfer);
}

function fail(request: DocumentRequest, error: unknown): void {
  const message: DocumentWorkerMessage = {
    protocol: DOCUMENT_PROTOCOL,
    kind: "response",
    requestId: request.requestId,
    generation: request.generation,
    ok: false,
    error,
  };
  scope.postMessage(message);
}

function resolveAsset(name: string, assetBaseUrl?: string): string {
  if (assetBaseUrl !== undefined) {
    const base = new URL(assetBaseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:" && base.protocol !== "file:") {
      throw workerError("RUNTIME_FAILURE", "assetBaseUrl uses an unsupported scheme");
    }
    if ((base.protocol === "http:" || base.protocol === "https:") && base.origin !== scope.location.origin) {
      throw workerError("RUNTIME_FAILURE", "assetBaseUrl must be same-origin; remote runtime assets are disabled");
    }
    return new URL(name, base).href;
  }
  return new URL(name, scope.location.href).href;
}

function validateLimits(value: WorkerLimits, inputBytes: number): void {
  for (const [name, limitValue] of Object.entries(value)) {
    if (!Number.isSafeInteger(limitValue) || limitValue <= 0) throw workerError("RUNTIME_FAILURE", `Invalid ${name} limit`);
  }
  if (inputBytes > value.maxInputBytes) throw limit("input", inputBytes, value.maxInputBytes);
}

function internalRotation(page: unknown): number {
  const raw = page as { module?: { _FPDFPage_GetRotation?: (index: number) => number }; pageIdx?: number };
  const value = raw.module?._FPDFPage_GetRotation?.(raw.pageIdx ?? 0);
  return Number.isInteger(value) && value! >= 0 && value! <= 3 ? value! : 0;
}

function internalClosePage(page: unknown): void {
  const raw = page as { module?: { _FPDF_ClosePage?: (index: number) => void }; pageIdx?: number };
  if (raw.pageIdx !== undefined) raw.module?._FPDF_ClosePage?.(raw.pageIdx);
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer;
}

function normalizePdfOpenError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Password required")) return workerError("PASSWORD_REQUIRED", "Encrypted PDFs are not supported in this preview");
  if (message.includes("Unsupported security")) return workerError("UNSUPPORTED_ENCRYPTION", "The PDF uses an unsupported encryption scheme");
  return workerError("PARSE_FAILED", "PDFium could not parse the local PDF", error);
}

function normalizeError(error: unknown, operation: DocumentRequest["operation"]): unknown {
  if (typeof error === "object" && error !== null && "code" in error) return error;
  const code: DocumentErrorCode = operation === "renderPage" ? "RENDER_FAILED" : operation === "open" ? "PARSE_FAILED" : "RUNTIME_FAILURE";
  return workerError(code, "The PDF Worker operation failed", error);
}

function workerError(code: DocumentErrorCode, message: string, cause?: unknown): { code: DocumentErrorCode; message: string } {
  void cause;
  return { code, message };
}

function limit(resource: string, requiredBytes: number, availableBytes: number): { code: "RESOURCE_LIMIT"; message: string; details: object } {
  return { code: "RESOURCE_LIMIT", message: `The PDF exceeds the ${resource} limit`, details: { resource, requiredBytes, availableBytes } };
}

function isRequest(value: unknown): value is DocumentRequest {
  return typeof value === "object" && value !== null
    && (value as { protocol?: unknown }).protocol === DOCUMENT_PROTOCOL
    && Number.isSafeInteger((value as { requestId?: unknown }).requestId)
    && Number.isSafeInteger((value as { generation?: unknown }).generation)
    && typeof (value as { operation?: unknown }).operation === "string";
}
