import type { SerializedError } from "../protocol.js";
import { isRecord } from "../protocol.js";
import { normalizeResourceLimitDetails } from "../errors.js";

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
    this.details = code === "RESOURCE_LIMIT"
      ? normalizeResourceLimitDetails(details)
      : details;
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
  const details = fault.code === "RESOURCE_LIMIT"
    ? normalizeResourceLimitDetails(fault.details)
    : fault.details;
  return {
    code: fault.code,
    message: fault.message,
    retryable: fault.retryable,
    ...(details === undefined
      ? {}
      : { details: normalizeFaultDetails(fault.code, details) }),
  };
}

/**
 * Keep legacy Rust adapter diagnostics legible while the v2 adapters converge
 * on the public resource vocabulary. Counts intentionally remain `required` /
 * `available`; byte reservations use the explicit `*Bytes` names.
 */
function normalizeFaultDetails(code: string, details: unknown): unknown {
  if (code !== "RESOURCE_LIMIT" || !isRecord(details)) {
    return details;
  }
  const resource = typeof details.resource === "string"
    ? details.resource
    : typeof details.resourceCategory === "string"
      ? details.resourceCategory
      : undefined;
  if (resource === undefined || details.resource === resource) {
    return details;
  }
  const { resourceCategory: _legacyResourceCategory, ...rest } = details;
  return { ...rest, resource };
}
