import { ADAPTER_API_VERSION } from "./protocol.js";

/** The only adapter identifiers accepted by the pre-alpha runtime. */
export type OfficialAdapterId = "tabulark:delimited" | "tabulark:arrow-ipc";

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

/**
 * A frozen descriptor for one built-in adapter.
 *
 * This deliberately is not an adapter factory: the Worker recognizes only
 * descriptors created by this module and it owns the corresponding WASM URL.
 */
export interface AdapterDescriptor<
  Id extends OfficialAdapterId = OfficialAdapterId,
  Options = unknown,
> {
  readonly id: Id;
  readonly adapterApiVersion: typeof ADAPTER_API_VERSION;
  /** A human-readable, non-configurable origin marker. */
  readonly kind: "official";
  /** Carries the option type without exposing a runtime extension point. */
  readonly __options?: Options;
}

interface InternalAdapterDescriptor<
  Id extends OfficialAdapterId = OfficialAdapterId,
  Options = unknown,
> extends AdapterDescriptor<Id, Options> {
  readonly [OFFICIAL_ADAPTER]: Readonly<{
    readonly id: Id;
  }>;
}

/**
 * A process-global symbol permits descriptors from the root and `/arrow`
 * entrypoints to be recognized after separate ESM bundles are loaded.
 */
const OFFICIAL_ADAPTER = Symbol.for("tabulark.official-adapter.v1");

export interface AdapterRegistration {
  readonly id: OfficialAdapterId;
  readonly moduleUrl: string;
}

/**
 * Artifact selection is owned by Tabulark, not by a descriptor supplied by an
 * application.  In particular, do not move these URLs into the public marker:
 * `Symbol.for` markers intentionally work across separately bundled root and
 * `/arrow` entrypoints, and so cannot be treated as a secret capability.
 */
const OFFICIAL_MODULE_URLS: Readonly<Record<OfficialAdapterId, string>> = Object.freeze({
  "tabulark:delimited": new URL(
    "./wasm/delimited/tabulark_delimited.js",
    import.meta.url,
  ).href,
  "tabulark:arrow-ipc": new URL(
    "./wasm/arrow/tabulark_arrow.js",
    import.meta.url,
  ).href,
});

function createOfficialAdapter<Id extends OfficialAdapterId, Options>(
  id: Id,
): AdapterDescriptor<Id, Options> {
  const marker = Object.freeze({ id });
  return Object.freeze({
    id,
    adapterApiVersion: ADAPTER_API_VERSION,
    kind: "official" as const,
    [OFFICIAL_ADAPTER]: marker,
  }) as InternalAdapterDescriptor<Id, Options>;
}

/** The built-in RFC-style delimited text adapter. */
export const delimitedAdapter = createOfficialAdapter<
  "tabulark:delimited",
  DelimitedAdapterOptions
>("tabulark:delimited");

/** @internal Used by the `/arrow` entrypoint to construct its frozen descriptor. */
export function createArrowIpcAdapter(): AdapterDescriptor<"tabulark:arrow-ipc", ArrowIpcAdapterOptions> {
  return createOfficialAdapter<"tabulark:arrow-ipc", ArrowIpcAdapterOptions>("tabulark:arrow-ipc");
}

/** @internal Validates and extracts the non-public Worker registration. */
export function resolveOfficialAdapter(value: unknown): AdapterRegistration | undefined {
  if (!isRecord(value) || !Object.isFrozen(value)) {
    return undefined;
  }
  if (
    (value.id !== "tabulark:delimited" && value.id !== "tabulark:arrow-ipc")
    || value.adapterApiVersion !== ADAPTER_API_VERSION
    || value.kind !== "official"
  ) {
    return undefined;
  }
  const marker = value[OFFICIAL_ADAPTER];
  if (!isRecord(marker) || marker.id !== value.id) {
    return undefined;
  }
  // Do not ever read a URL from `value` or its marker. A marker can be forged
  // by a separately loaded bundle, but it can only select an official ID.
  return Object.freeze({ id: value.id, moduleUrl: OFFICIAL_MODULE_URLS[value.id] });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
