import manifestJson from "./official-adapters.json" with { type: "json" };

export type OfficialAdapterId =
  | "tabulark:delimited"
  | "tabulark:arrow-ipc"
  | "tabulark:parquet"
  | "tabulark:excel";
export type OfficialSourceAccess = "streaming" | "range" | "staged";

export interface OfficialAdapterManifestEntry {
  readonly id: OfficialAdapterId;
  readonly entrypoint: "." | "./arrow" | "./parquet" | "./excel";
  readonly exportName: string;
  readonly wasm: Readonly<{
    readonly packageName: string;
    readonly crateArtifact: string;
    readonly outputName: string;
    readonly outputDirectory: string;
    readonly modulePath: string;
    readonly runtimeExport: "WasmRuntime";
  }>;
  readonly options: Readonly<{ readonly allowedKeys: readonly string[] }>;
  readonly resources: Readonly<{
    readonly sourceAccess: OfficialSourceAccess;
    readonly supportsPresentation: boolean;
    readonly runtimeWeight: number;
  }>;
}

const manifestEntries = validateManifest(manifestJson);

/** Runtime IDs are derived from the manifest rather than repeated in code. */
export const OFFICIAL_ADAPTER_IDS: readonly OfficialAdapterId[] = Object.freeze(
  manifestEntries.map((entry) => entry.id),
);

/** The sole internal source of truth for built-in IDs, artifacts and host policy. */
export const OFFICIAL_ADAPTER_MANIFEST: readonly OfficialAdapterManifestEntry[] = Object.freeze(
  manifestEntries.map((entry) => Object.freeze({
    ...entry,
    wasm: Object.freeze({ ...entry.wasm }),
    options: Object.freeze({
      allowedKeys: Object.freeze([...entry.options.allowedKeys]),
    }),
    resources: Object.freeze({ ...entry.resources }),
  })),
);

const byId = new Map(OFFICIAL_ADAPTER_MANIFEST.map((entry) => [entry.id, entry]));

export function isOfficialAdapterId(value: unknown): value is OfficialAdapterId {
  return typeof value === "string" && byId.has(value as OfficialAdapterId);
}

export function officialAdapterManifestEntry(id: OfficialAdapterId): OfficialAdapterManifestEntry {
  const entry = byId.get(id);
  if (!entry) {
    throw new TypeError(`Unknown official adapter: ${id}`);
  }
  return entry;
}

/** Resolves an official wrapper relative to the bundle that hosts this code. */
export function officialAdapterModuleUrl(id: OfficialAdapterId): string {
  return new URL(officialAdapterManifestEntry(id).wasm.modulePath, import.meta.url).href;
}

function validateManifest(value: unknown): readonly OfficialAdapterManifestEntry[] {
  if (!isRecord(value) || value.manifestVersion !== 1 || !Array.isArray(value.adapters)) {
    throw new TypeError("The official adapter manifest has an unsupported shape or version");
  }
  if (value.adapters.length === 0) {
    throw new TypeError("The official adapter manifest must contain at least one adapter");
  }
  const ids = new Set<string>();
  const entrypoints = new Set<string>();
  const outputDirectories = new Set<string>();
  return value.adapters.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new TypeError(`Official adapter manifest entry ${index} must be an object`);
    }
    const { id, entrypoint, exportName, wasm, options, resources } = candidate;
    if (!isKnownOfficialAdapterId(id) || ids.has(id)) {
      throw new TypeError(`Official adapter manifest entry ${index} has an invalid or duplicate id`);
    }
    if (
      (entrypoint !== "." && entrypoint !== "./arrow" && entrypoint !== "./parquet" && entrypoint !== "./excel")
      || entrypoints.has(entrypoint)
      || typeof exportName !== "string"
      || exportName.length === 0
    ) {
      throw new TypeError(`Official adapter manifest entry ${index} has an invalid entrypoint or export`);
    }
    if (
      !isRecord(wasm)
      || typeof wasm.packageName !== "string"
      || typeof wasm.crateArtifact !== "string"
      || typeof wasm.outputName !== "string"
      || typeof wasm.outputDirectory !== "string"
      || !wasm.outputDirectory.startsWith("dist/wasm/")
      || wasm.outputDirectory.includes("..")
      || outputDirectories.has(wasm.outputDirectory)
      || typeof wasm.modulePath !== "string"
      || !wasm.modulePath.startsWith("./wasm/")
      || wasm.modulePath.includes("..")
      || wasm.modulePath.includes("?")
      || wasm.modulePath.includes("#")
      || wasm.runtimeExport !== "WasmRuntime"
      || wasm.modulePath !== `./${wasm.outputDirectory.replace(/^dist\//u, "")}/${wasm.outputName}.js`
    ) {
      throw new TypeError(`Official adapter manifest entry ${index} has an invalid WASM artifact`);
    }
    if (
      !isRecord(options)
      || !Array.isArray(options.allowedKeys)
      || options.allowedKeys.some((key) => typeof key !== "string")
      || new Set(options.allowedKeys).size !== options.allowedKeys.length
    ) {
      throw new TypeError(`Official adapter manifest entry ${index} has invalid option keys`);
    }
    if (
      !isRecord(resources)
      || (resources.sourceAccess !== "streaming"
        && resources.sourceAccess !== "range"
        && resources.sourceAccess !== "staged")
      || typeof resources.supportsPresentation !== "boolean"
      || !Number.isSafeInteger(resources.runtimeWeight)
      || (resources.runtimeWeight as number) <= 0
    ) {
      throw new TypeError(`Official adapter manifest entry ${index} has an invalid resource policy`);
    }
    ids.add(id);
    entrypoints.add(entrypoint);
    outputDirectories.add(wasm.outputDirectory);
    return candidate as unknown as OfficialAdapterManifestEntry;
  });
}

function isKnownOfficialAdapterId(value: unknown): value is OfficialAdapterId {
  return value === "tabulark:delimited"
    || value === "tabulark:arrow-ipc"
    || value === "tabulark:parquet"
    || value === "tabulark:excel";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
