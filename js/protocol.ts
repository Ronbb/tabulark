export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type Operation =
  | "hello"
  | "openSource"
  | "listTables"
  | "openTable"
  | "getMetadata"
  | "readRange"
  | "cancel"
  | "closeTable"
  | "closeSource"
  | "shutdown";

export interface ProtocolRequest<T = unknown> {
  readonly protocolVersion: ProtocolVersion;
  readonly requestId: string;
  readonly op: Operation;
  readonly payload: T;
}

export type ResponseKind =
  | "hello"
  | "dataset"
  | "tables"
  | "table"
  | "metadata"
  | "batch"
  | "acknowledged";

export interface ProtocolResult<T = unknown> {
  readonly kind: ResponseKind;
  readonly data?: T;
}

export interface ProtocolSuccess<T = unknown> {
  readonly protocolVersion: ProtocolVersion;
  readonly requestId: string;
  readonly status: "success";
  readonly result: ProtocolResult<T>;
}

export interface SerializedError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

export interface ProtocolFailure {
  readonly protocolVersion: ProtocolVersion;
  readonly requestId: string;
  readonly status: "failure";
  readonly error: SerializedError;
}

export type ProtocolResponse<T = unknown> =
  | ProtocolSuccess<T>
  | ProtocolFailure;

export type RuntimeEventName =
  | "progress"
  | "metadata"
  | "warning"
  | "closed"
  | "runtimeError";

export interface ProtocolEvent<T = unknown> {
  readonly protocolVersion: ProtocolVersion;
  readonly requestId?: string;
  readonly event: RuntimeEventName;
  /** Required for dataset/table events; omitted only by a process-wide runtimeError. */
  readonly datasetHandle?: string;
  readonly tableHandle?: string;
  readonly tableId?: string;
  readonly payload: T;
}

export function isProtocolResponse(value: unknown): value is ProtocolResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.protocolVersion === PROTOCOL_VERSION &&
    typeof value.requestId === "string" &&
    (value.status === "success" || value.status === "failure")
  );
}

export function isProtocolEvent(value: unknown): value is ProtocolEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.protocolVersion === PROTOCOL_VERSION &&
    typeof value.event === "string" &&
    "payload" in value
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
