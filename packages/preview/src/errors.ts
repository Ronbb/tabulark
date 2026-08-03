import type { PreviewErrorCode } from "./types.js";

export class PreviewError extends Error {
  readonly code: PreviewErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(code: PreviewErrorCode, message: string, options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PreviewError";
    this.code = code;
    this.details = options.details;
  }
}
export function resourceLimit(resource: string, actual: number, limit: number): PreviewError {
  return new PreviewError("RESOURCE_LIMIT", `The preview exceeds the ${resource} limit`, { details: { resource, actual, limit } });
}
export function cancelled(): PreviewError { return new PreviewError("CANCELLED", "The preview operation was cancelled"); }
export function closed(): PreviewError { return new PreviewError("HANDLE_CLOSED", "The preview session is closed"); }
