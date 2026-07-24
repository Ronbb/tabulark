import type { SerializedError } from "./protocol.js";

export type TabularkErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_RANGE"
  | "RANGE_NOT_INDEXED"
  | "RESOURCE_LIMIT"
  | "CANCELLED"
  | "HANDLE_CLOSED"
  | "PROTOCOL_INCOMPATIBLE"
  | "PARSE_FAILED"
  | "UNSUPPORTED_RUNTIME"
  | "RUNTIME_FAILURE"
  | (string & {});

/** A stable, serializable error returned by Tabulark. */
export class TabularkError extends Error {
  readonly code: TabularkErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: TabularkErrorCode,
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TabularkError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  static fromSerialized(error: SerializedError): TabularkError {
    return new TabularkError(error.code, error.message, {
      retryable: error.retryable,
      details: error.details,
    });
  }
}

export function cancelledError(): TabularkError {
  return new TabularkError("CANCELLED", "The operation was cancelled");
}

export function closedError(resource: string): TabularkError {
  return new TabularkError("HANDLE_CLOSED", `${resource} is closed`);
}

export function invalidArgument(message: string, details?: unknown): TabularkError {
  return new TabularkError("INVALID_ARGUMENT", message, { details });
}
