export type PreviewKind = "text" | "structured" | "image" | "paged" | "media" | "archive" | "map";
export type PreviewFormat =
  | "json" | "jsonl" | "yaml" | "xml" | "toml"
  | "text" | "markdown" | "log" | "ini" | "env" | "properties" | "code"
  | "png" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "tiff" | "heic"
  | "pdf";
export type PreviewFidelity = "exact" | "semantic" | "preview-grade-layout" | "metadata-only";
export type PreviewErrorCode = "UNSUPPORTED_FORMAT" | "PARSE_FAILED" | "RESOURCE_LIMIT" | "CANCELLED" | "HANDLE_CLOSED" | "SOURCE_CHANGED" | "RUNTIME_FAILURE";

export interface PreviewDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
}
export interface PreviewMetadata {
  readonly sourceName?: string;
  readonly size: number;
  readonly snapshot: RangeSourceSnapshot;
  readonly fidelity: PreviewFidelity;
  readonly mediaType?: string;
  readonly encoding?: string;
  readonly [key: string]: unknown;
}
export interface PreviewCapabilities {
  readonly localOnly: true;
  readonly remoteRange: boolean;
  readonly search: boolean;
  readonly pagination: boolean;
  readonly tree: boolean;
  readonly tableProjection: boolean;
  readonly zoom: boolean;
}
export interface PreviewSessionBase {
  readonly kind: PreviewKind;
  readonly format: PreviewFormat;
  readonly metadata: PreviewMetadata;
  readonly capabilities: PreviewCapabilities;
  getDiagnostics(): readonly PreviewDiagnostic[];
  subscribe(listener: (diagnostic: PreviewDiagnostic) => void): () => void;
  close(): Promise<void>;
}
export interface TextRange { readonly offset: number; readonly length: number }
export interface TextLine { readonly number: number; readonly text: string; readonly start: number; readonly end: number }
export interface TextSearchMatch { readonly start: number; readonly end: number; readonly line: number; readonly preview: string }
export interface TextSession extends PreviewSessionBase {
  readonly kind: "text";
  readonly lineCount: number;
  getText(range?: TextRange): string;
  getLines(offset: number, limit: number): readonly TextLine[];
  search(query: string, options?: { readonly caseSensitive?: boolean; readonly maxResults?: number }): readonly TextSearchMatch[];
}
export type StructuredNodeType = "object" | "array" | "string" | "number" | "boolean" | "null";
export interface StructuredNode {
  readonly id: number;
  readonly parentId?: number;
  readonly key?: string | number;
  readonly type: StructuredNodeType;
  readonly value?: string | number | boolean | null;
  readonly childCount: number;
  readonly depth: number;
}
export interface TableProjection { readonly columns: readonly string[]; readonly rows: readonly Readonly<Record<string, unknown>>[] }
export interface StructuredSession extends PreviewSessionBase {
  readonly kind: "structured";
  readonly rootId: number;
  getNodes(offset: number, limit: number): readonly StructuredNode[];
  getChildren(nodeId: number, offset?: number, limit?: number): readonly StructuredNode[];
  projectArray(nodeId: number, options?: { readonly offset?: number; readonly limit?: number }): TableProjection;
  getRawText(range?: TextRange): string;
}
export interface ImageSession extends PreviewSessionBase {
  readonly kind: "image";
  readonly width?: number;
  readonly height?: number;
  readonly frameCount?: number;
  getBlob(): Blob;
}
export type PreviewSession = TextSession | StructuredSession | ImageSession | PreviewSessionBase;

export interface ByteRange { readonly offset: number; readonly length: number }
export interface RangeSourceSnapshot { readonly id: string; readonly strength: "strong" | "weak" }
export interface RangeSourceReader {
  readonly size: number;
  readonly snapshot: RangeSourceSnapshot;
  readonly maxConcurrency?: number;
  read(range: ByteRange, options: { readonly signal: AbortSignal }): Promise<ArrayBuffer | ArrayBufferView>;
  close(): Promise<void> | void;
}
export interface RangeSource {
  readonly kind: "range";
  readonly name?: string;
  open(options: { readonly signal: AbortSignal; readonly maxSourceBytes: number; readonly maxStagingBytes: number }): Promise<RangeSourceReader>;
}
export type PreviewSource = Blob | ArrayBuffer | ArrayBufferView | RangeSource;
export interface PreviewLimits {
  readonly maxSourceBytes?: number;
  readonly maxInputBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxTextLines?: number;
  readonly maxSearchResults?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxImagePixels?: number;
  readonly maxRangeConcurrency?: number;
}
export interface PreviewProvider {
  readonly id: string;
  readonly formats: readonly PreviewFormat[];
  readonly kinds: readonly PreviewKind[];
}
export interface PreviewEngineOptions { readonly providers?: readonly PreviewProvider[]; readonly limits?: PreviewLimits }
export interface PreviewOpenOptions { readonly format?: "auto" | PreviewFormat; readonly sourceName?: string; readonly signal?: AbortSignal }
export interface PreviewEngine {
  open(source: PreviewSource, options?: PreviewOpenOptions): Promise<PreviewSession>;
  close(): Promise<void>;
}
