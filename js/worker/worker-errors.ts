import type { SerializedError } from "../protocol.js";
import { isRecord } from "../protocol.js";

export class ProtocolFault extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: unknown,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ProtocolFault";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function faultFromUnknown(error: unknown, fallback: string): ProtocolFault {
  if (error instanceof ProtocolFault) {
    return error;
  }
  if (isRecord(error)) {
    return new ProtocolFault(
      typeof error.code === "string" ? error.code : "RUNTIME_FAILURE",
      typeof error.message === "string" ? error.message : fallback,
      error.retryable === true,
      error.details,
      error,
    );
  }
  if (error instanceof Error) {
    return new ProtocolFault("RUNTIME_FAILURE", error.message || fallback, false, undefined, error);
  }
  return new ProtocolFault("RUNTIME_FAILURE", fallback, false, { value: String(error) });
}

export function serializeFault(error: unknown, fallback: string): SerializedError {
  const fault = faultFromUnknown(error, fallback);
  return {
    code: fault.code,
    message: fault.message,
    retryable: fault.retryable,
    ...(fault.details === undefined ? {} : { details: fault.details }),
  };
}
