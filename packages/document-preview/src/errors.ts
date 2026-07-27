import type { DocumentErrorCode } from "./types.js";

export class DocumentPreviewError extends Error {
  readonly code: DocumentErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: DocumentErrorCode,
    message: string,
    options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DocumentPreviewError";
    this.code = code;
    this.details = options.details;
  }
}

export function cancelledError(): DocumentPreviewError {
  return new DocumentPreviewError("CANCELLED", "The document operation was cancelled");
}

export function closedError(): DocumentPreviewError {
  return new DocumentPreviewError("HANDLE_CLOSED", "The document session is closed");
}

export function asDocumentError(value: unknown, fallback: DocumentErrorCode): DocumentPreviewError {
  if (value instanceof DocumentPreviewError) return value;
  if (isRecord(value) && isDocumentErrorCode(value.code)) {
    return new DocumentPreviewError(
      value.code,
      typeof value.message === "string" ? value.message : "The document operation failed",
      isRecord(value.details) ? { details: value.details } : {},
    );
  }
  return new DocumentPreviewError(fallback, "The document operation failed", { cause: value });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDocumentErrorCode(value: unknown): value is DocumentErrorCode {
  return typeof value === "string" && CODES.has(value as DocumentErrorCode);
}

const CODES = new Set<DocumentErrorCode>([
  "UNSUPPORTED_FORMAT", "PARSE_FAILED", "LAYOUT_FAILED", "RENDER_FAILED",
  "RESOURCE_LIMIT", "CANCELLED", "PASSWORD_REQUIRED", "UNSUPPORTED_ENCRYPTION",
  "PROTOCOL_INCOMPATIBLE", "HANDLE_CLOSED", "RUNTIME_FAILURE",
]);
