export type DocumentFormat = "pdf" | "docx";

export type DocumentErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "PARSE_FAILED"
  | "LAYOUT_FAILED"
  | "RENDER_FAILED"
  | "RESOURCE_LIMIT"
  | "CANCELLED"
  | "PASSWORD_REQUIRED"
  | "UNSUPPORTED_ENCRYPTION"
  | "PROTOCOL_INCOMPATIBLE"
  | "HANDLE_CLOSED"
  | "RUNTIME_FAILURE";

export interface DocumentDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly pageIndex?: number;
}

export interface DocumentCapabilities {
  /** PDF page metadata comes from the source; DOCX pages come from the preview layout. */
  readonly pagination: "source-pdf" | "preview-layout";
  readonly localOnly: true;
  readonly textSelection: false;
  readonly search: false;
  readonly print: false;
  readonly exportImages: false;
}

export interface DocumentPageInfo {
  readonly pageIndex: number;
  /** PDF points at 72 DPI. */
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface RenderPageOptions {
  readonly cssWidth: number;
  readonly devicePixelRatio?: number;
  readonly signal?: AbortSignal;
}

export interface RenderedDocumentPage {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly colorSpace: "srgb";
  readonly pixels: ArrayBuffer;
}

export interface PagedDocumentSession {
  readonly format: DocumentFormat;
  readonly pageCount: number;
  readonly capabilities: DocumentCapabilities;
  getPageInfo(index: number): Promise<DocumentPageInfo>;
  renderPage(index: number, options: RenderPageOptions): Promise<RenderedDocumentPage>;
  getDiagnostics(): readonly DocumentDiagnostic[];
  subscribe(listener: (diagnostic: DocumentDiagnostic) => void): () => void;
  close(): Promise<void>;
}

export type LocalDocumentSource = Blob | ArrayBuffer;

export interface OpenDocumentOptions {
  readonly sourceName?: string;
  readonly signal?: AbortSignal;
}

export interface DocumentWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface DocumentProviderDescriptor {
  readonly id: string;
  readonly format: DocumentFormat;
  readonly fidelity: "exact-source-pages" | "preview-grade-layout";
  readonly sniff: (head: Uint8Array, sourceName?: string) => boolean;
  /** Must construct a bundled/local Worker; module URLs are never accepted by the engine. */
  readonly createWorker: () => DocumentWorkerLike;
}

export interface DocumentEngineOptions {
  readonly providers: readonly DocumentProviderDescriptor[];
  readonly assetBaseUrl?: URL;
  readonly memoryBudgetBytes?: number;
  readonly maxInputBytes?: number;
  readonly pageCacheBytes?: number;
  readonly maxPagePixels?: number;
  readonly maxPages?: number;
  readonly maxIntermediateBytes?: number;
}

export interface DocumentEngine {
  open(source: LocalDocumentSource, options?: OpenDocumentOptions): Promise<PagedDocumentSession>;
  close(): Promise<void>;
}
