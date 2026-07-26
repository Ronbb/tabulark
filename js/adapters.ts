import {
  isOfficialAdapterId,
  officialAdapterManifestEntry,
  type OfficialAdapterId,
} from "./official-adapter-manifest.js";

export type { OfficialAdapterId } from "./official-adapter-manifest.js";

export type DelimitedDialect = "csv" | "tsv";
export type HeaderMode = "first-row" | "none";
export type ParseMode = "lenient" | "strict";

/** Options understood by the built-in delimited adapter. */
export interface DelimitedAdapterOptions {
  /** Defaults to `csv`. No filename-based selection is performed. */
  readonly dialect?: DelimitedDialect;
  readonly header?: HeaderMode;
  readonly mode?: ParseMode;
  /** One ASCII delimiter byte. Overrides the dialect default when supplied. */
  readonly delimiter?: string;
  /** Optional display name for the source. */
  readonly sourceName?: string;
}

export type ArrowIpcContainer = "auto" | "file" | "stream";

/** Options understood by the built-in Arrow IPC adapter. */
export interface ArrowIpcAdapterOptions {
  /** Defaults to `auto`; format detection belongs to the Arrow adapter. */
  readonly container?: ArrowIpcContainer;
  /** Optional display name for the source. */
  readonly sourceName?: string;
}

/** Options understood by the built-in Parquet adapter. */
export interface ParquetAdapterOptions {
  /** Optional display name for the source. */
  readonly sourceName?: string;
}

export type ExcelFormat = "auto" | "xls" | "xlsx";

/** Options understood by the built-in Excel adapter. */
export interface ExcelAdapterOptions {
  /** Defaults to `auto`; the adapter identifies the file from its signature. */
  readonly format?: ExcelFormat;
  /** Optional display name for the source. */
  readonly sourceName?: string;
}

/**
 * A frozen descriptor for one built-in adapter.
 *
 * Descriptors select a named official artifact only. They are deliberately not
 * factories and cannot carry a module URL or a third-party implementation.
 */
export interface AdapterDescriptor<
  Id extends OfficialAdapterId = OfficialAdapterId,
  Options = unknown,
> {
  readonly id: Id;
  readonly kind: "official";
  /** Carries the option type without exposing a runtime extension point. */
  readonly __options?: Options;
}

interface InternalAdapterDescriptor<
  Id extends OfficialAdapterId = OfficialAdapterId,
  Options = unknown,
> extends AdapterDescriptor<Id, Options> {
  readonly [OFFICIAL_ADAPTER]: Readonly<{ readonly id: Id }>;
}

/**
 * A process-global symbol permits descriptors from separately bundled stable
 * entrypoints to be recognized. It conveys no capability: the manifest below
 * still owns the selected module URL and resource policy.
 */
const OFFICIAL_ADAPTER = Symbol.for("tabulark.official-adapter.v2");

export interface AdapterRegistration {
  readonly id: OfficialAdapterId;
}

function createOfficialAdapter<Id extends OfficialAdapterId, Options>(
  id: Id,
): AdapterDescriptor<Id, Options> {
  const marker = Object.freeze({ id });
  return Object.freeze({
    id,
    kind: "official" as const,
    [OFFICIAL_ADAPTER]: marker,
  }) as InternalAdapterDescriptor<Id, Options>;
}

/** The built-in RFC-style delimited text adapter. */
export const delimitedAdapter = createOfficialAdapter<
  "tabulark:delimited",
  DelimitedAdapterOptions
>("tabulark:delimited");

/** @internal Used by the stable `/arrow` entrypoint. */
export function createArrowIpcAdapter(): AdapterDescriptor<"tabulark:arrow-ipc", ArrowIpcAdapterOptions> {
  return createOfficialAdapter<"tabulark:arrow-ipc", ArrowIpcAdapterOptions>("tabulark:arrow-ipc");
}

/** @internal Used by the stable `/parquet` entrypoint. */
export function createParquetAdapter(): AdapterDescriptor<"tabulark:parquet", ParquetAdapterOptions> {
  return createOfficialAdapter<"tabulark:parquet", ParquetAdapterOptions>("tabulark:parquet");
}

/** @internal Used by the stable `/excel` entrypoint. */
export function createExcelAdapter(): AdapterDescriptor<"tabulark:excel", ExcelAdapterOptions> {
  return createOfficialAdapter<"tabulark:excel", ExcelAdapterOptions>("tabulark:excel");
}

/** @internal Validates and extracts the non-public Worker registration. */
export function resolveOfficialAdapter(value: unknown): AdapterRegistration | undefined {
  if (!isRecord(value) || !Object.isFrozen(value) || !isOfficialAdapterId(value.id) || value.kind !== "official") {
    return undefined;
  }
  const marker = value[OFFICIAL_ADAPTER];
  if (!isRecord(marker) || marker.id !== value.id) {
    return undefined;
  }
  // A marker may be recreated by another bundle, but it conveys no URL or
  // implementation capability: it can select only a manifest-owned ID.
  officialAdapterManifestEntry(value.id);
  return Object.freeze({ id: value.id });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
