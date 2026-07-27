import type {
  DocumentCapabilities,
  DocumentDiagnostic,
  DocumentFormat,
  DocumentPageInfo,
  RenderedDocumentPage,
} from "./types.js";

export const DOCUMENT_PROTOCOL = "document-protocol-v1" as const;

export type DocumentRequest =
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly requestId: number; readonly generation: number; readonly operation: "hello" }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly requestId: number; readonly generation: number; readonly operation: "open"; readonly sessionId: string; readonly format: DocumentFormat; readonly bytes: ArrayBuffer; readonly limits: WorkerLimits; readonly assetBaseUrl?: string }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly requestId: number; readonly generation: number; readonly operation: "pageInfo"; readonly sessionId: string; readonly pageIndex: number }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly requestId: number; readonly generation: number; readonly operation: "renderPage"; readonly sessionId: string; readonly pageIndex: number; readonly pixelWidth: number }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly requestId: number; readonly generation: number; readonly operation: "cancel"; readonly sessionId: string; readonly targetRequestId: number }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly requestId: number; readonly generation: number; readonly operation: "close"; readonly sessionId: string }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly requestId: number; readonly generation: number; readonly operation: "shutdown" };

export interface WorkerLimits {
  readonly memoryBudgetBytes: number;
  readonly maxInputBytes: number;
  readonly maxIntermediateBytes: number;
  readonly maxPagePixels: number;
  readonly maxPages: number;
}

export type DocumentResponseResult =
  | { readonly operation: "hello"; readonly protocol: typeof DOCUMENT_PROTOCOL }
  | { readonly operation: "open"; readonly pageCount: number; readonly capabilities: DocumentCapabilities }
  | { readonly operation: "pageInfo"; readonly page: DocumentPageInfo }
  | { readonly operation: "renderPage"; readonly page: RenderedDocumentPage }
  | { readonly operation: "close" | "shutdown" | "cancel" };

export type DocumentWorkerMessage =
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly kind: "response"; readonly requestId: number; readonly generation: number; readonly ok: true; readonly result: DocumentResponseResult }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly kind: "response"; readonly requestId: number; readonly generation: number; readonly ok: false; readonly error: unknown }
  | { readonly protocol: typeof DOCUMENT_PROTOCOL; readonly kind: "diagnostic"; readonly generation: number; readonly diagnostic: DocumentDiagnostic };

export function isWorkerMessage(value: unknown): value is DocumentWorkerMessage {
  if (!isRecord(value) || value.protocol !== DOCUMENT_PROTOCOL || !safeInteger(value.generation)) return false;
  if (value.kind === "diagnostic") return isDiagnostic(value.diagnostic);
  return value.kind === "response"
    && safeInteger(value.requestId)
    && typeof value.ok === "boolean"
    && (value.ok ? isRecord(value.result) : "error" in value);
}

function isDiagnostic(value: unknown): value is DocumentDiagnostic {
  return isRecord(value)
    && (value.severity === "warning" || value.severity === "error")
    && typeof value.code === "string"
    && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
