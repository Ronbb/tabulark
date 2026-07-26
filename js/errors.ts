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
  | "UNSUPPORTED_FEATURE"
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
    this.details = code === "RESOURCE_LIMIT"
      ? normalizeResourceLimitDetails(options.details)
      : options.details;
  }

  static fromSerialized(error: SerializedError): TabularkError {
    return new TabularkError(error.code, error.message, {
      retryable: error.retryable,
      details: error.details,
    });
  }
}

/** @internal Ensures every resource-limit error has a stable capacity shape. */
export function normalizeResourceLimitDetails(details: unknown): Readonly<Record<string, unknown>> {
  const raw = isRecord(details) ? details : {};
  const resource = typeof raw.resource === "string" && raw.resource.length > 0
    ? raw.resource
    : typeof raw.resourceCategory === "string" && raw.resourceCategory.length > 0
      ? raw.resourceCategory
      : inferResource(raw);
  if (isQuantity(raw.requiredBytes) && isQuantity(raw.availableBytes)) {
    return Object.freeze({ ...raw, resource });
  }
  if (isQuantity(raw.required) && isQuantity(raw.available)) {
    return Object.freeze({ ...raw, resource });
  }

  const byteLimit = firstQuantity(raw, [
    "maxDecodedBytes",
    "maxOutputBytes",
    "maxMetadataBytes",
    "maxBlockBytes",
    "maxDisplayCellBytes",
    "maxDisplayBytes",
    "maxSourceBytes",
    "maxFieldBytes",
    "maxBatchBytes",
    "maxOperationBytes",
    "maxZipEntryBytes",
    "maxZipUncompressedBytes",
    "maxCfbStreamBytes",
  ]);
  if (byteLimit !== undefined) {
    const requiredBytes = firstQuantity(raw, [
      "decodedBytes",
      "outputBytes",
      "metadataBytes",
      "blockBytes",
      "displayCellBytes",
      "displayBytes",
      "sourceBytes",
      "fieldBytes",
      "batchBytes",
      "operationBytes",
    ]) ?? byteLimit + 1;
    return Object.freeze({
      ...raw,
      resource,
      requiredBytes,
      availableBytes: byteLimit,
    });
  }

  const available = firstQuantity(raw, [
    "limit",
    "maxCells",
    "maxRangeCells",
    "maxSources",
    "maxActiveRanges",
    "maxRangeWaiters",
    "maxColumns",
    "maxFields",
    "maxNestingDepth",
    "maxWorksheetRows",
    "maxWorksheetColumns",
    "maxStyles",
    "maxMergedRegions",
  ]) ?? 0;
  const required = firstQuantity(raw, [
    "cells",
    "cellCount",
    "visibleCellCount",
    "sources",
    "activeRanges",
    "rangeWaiters",
    "columns",
    "fields",
    "nestingDepth",
    "worksheetRows",
    "worksheetColumns",
    "styles",
    "mergedRegions",
  ]) ?? available + 1;
  return Object.freeze({ ...raw, resource, required, available });
}

function inferResource(details: Record<string, unknown>): string {
  const keys = Object.keys(details).join(" ").toLowerCase();
  if (keys.includes("source")) return keys.includes("byte") ? "source-staging" : "source-slots";
  if (keys.includes("metadata")) return "metadata";
  if (keys.includes("decoded") || keys.includes("decompress")) return "decompression";
  if (keys.includes("display")) return "display-values";
  if (keys.includes("field")) return "field";
  if (keys.includes("batch")) return "batch";
  if (keys.includes("range") || keys.includes("cell")) return "range-cells";
  if (keys.includes("column")) return "columns";
  if (keys.includes("nest")) return "descriptor-nesting";
  if (keys.includes("worksheet")) return "worksheet-dimensions";
  return "adapter-resource";
}

function firstQuantity(
  details: Record<string, unknown>,
  names: readonly string[],
): number | undefined {
  for (const name of names) {
    if (isQuantity(details[name])) return details[name] as number;
  }
  return undefined;
}

function isQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
