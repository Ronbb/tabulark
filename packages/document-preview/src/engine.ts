import { asDocumentError, cancelledError, closedError, DocumentPreviewError } from "./errors.js";
import { DOCUMENT_PROTOCOL, isWorkerMessage } from "./protocol.js";
import type { DocumentRequest, DocumentResponseResult, WorkerLimits } from "./protocol.js";
import type {
  DocumentDiagnostic,
  DocumentEngine,
  DocumentEngineOptions,
  DocumentPageInfo,
  DocumentProviderDescriptor,
  DocumentWorkerLike,
  LocalDocumentSource,
  OpenDocumentOptions,
  PagedDocumentSession,
  RenderedDocumentPage,
  RenderPageOptions,
} from "./types.js";

const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  memoryBudgetBytes: 256 * MiB,
  maxInputBytes: 64 * MiB,
  pageCacheBytes: 64 * MiB,
  maxPagePixels: 8_000_000,
  maxPages: 2_000,
  maxIntermediateBytes: 128 * MiB,
});

interface NormalizedOptions extends WorkerLimits {
  readonly providers: readonly DocumentProviderDescriptor[];
  readonly assetBaseUrl: URL | undefined;
  readonly pageCacheBytes: number;
}

type RequestBody = DocumentRequest extends infer Request
  ? Request extends DocumentRequest
    ? Omit<Request, "protocol" | "requestId" | "generation">
    : never
  : never;

class RpcClient {
  private nextRequestId = 1;
  private generation = 1;
  private stopped = false;
  private readonly pending = new Map<number, {
    readonly generation: number;
    readonly resolve: (result: DocumentResponseResult) => void;
    readonly reject: (error: unknown) => void;
  }>();
  onDiagnostic: ((diagnostic: DocumentDiagnostic) => void) | undefined;

  constructor(private readonly worker: DocumentWorkerLike) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
  }

  async hello(): Promise<void> {
    const result = await this.request({ operation: "hello" });
    if (result.operation !== "hello" || result.protocol !== DOCUMENT_PROTOCOL) {
      throw new DocumentPreviewError("PROTOCOL_INCOMPATIBLE", "The document Worker protocol is incompatible");
    }
  }

  request(
    body: RequestBody,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
  ): Promise<DocumentResponseResult> {
    if (this.stopped) return Promise.reject(closedError());
    if (signal?.aborted === true) return Promise.reject(cancelledError());
    const requestId = this.nextRequestId++;
    const generation = this.generation;
    const request = { ...body, protocol: DOCUMENT_PROTOCOL, requestId, generation } as DocumentRequest;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        this.pending.delete(requestId);
        try {
          this.worker.postMessage({
            protocol: DOCUMENT_PROTOCOL,
            requestId: this.nextRequestId++,
            generation,
            operation: "cancel",
            sessionId: "sessionId" in body && typeof body.sessionId === "string" ? body.sessionId : "",
            targetRequestId: requestId,
          } satisfies DocumentRequest);
        } catch { /* termination is also cancellation */ }
        finish(() => reject(cancelledError()));
      };
      this.pending.set(requestId, {
        generation,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.worker.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(requestId);
        finish(() => reject(asDocumentError(error, "RUNTIME_FAILURE")));
      }
    });
  }

  bumpGeneration(): void {
    this.generation += 1;
    for (const entry of this.pending.values()) entry.reject(cancelledError());
    this.pending.clear();
  }

  terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bumpGeneration();
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.terminate();
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (!isWorkerMessage(event.data)) return;
    if (event.data.kind === "diagnostic") {
      if (event.data.generation === this.generation) this.onDiagnostic?.(event.data.diagnostic);
      return;
    }
    const entry = this.pending.get(event.data.requestId);
    if (entry === undefined || entry.generation !== event.data.generation) return;
    this.pending.delete(event.data.requestId);
    if (event.data.ok) entry.resolve(event.data.result);
    else entry.reject(asDocumentError(event.data.error, "RUNTIME_FAILURE"));
  };

  private readonly onError = (): void => {
    const error = new DocumentPreviewError("RUNTIME_FAILURE", "The document Worker stopped unexpectedly");
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  };
}

class Session implements PagedDocumentSession {
  readonly capabilities;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private renderQueue = Promise.resolve();
  private readonly diagnostics: DocumentDiagnostic[] = [];
  private readonly listeners = new Set<(diagnostic: DocumentDiagnostic) => void>();
  private readonly cache = new Map<number, RenderedDocumentPage>();
  private cacheBytes = 0;

  constructor(
    readonly format: PagedDocumentSession["format"],
    readonly pageCount: number,
    capabilities: PagedDocumentSession["capabilities"],
    private readonly sessionId: string,
    private readonly rpc: RpcClient,
    private readonly pageCacheBytes: number,
    private readonly maxPagePixels: number,
    private readonly onClose: () => void,
  ) {
    this.capabilities = Object.freeze({ ...capabilities });
    rpc.onDiagnostic = (diagnostic) => this.emit(diagnostic);
  }

  async getPageInfo(index: number): Promise<DocumentPageInfo> {
    this.assertOpen();
    this.assertPage(index);
    const result = await this.rpc.request({ operation: "pageInfo", sessionId: this.sessionId, pageIndex: index });
    if (result.operation !== "pageInfo") throw invalidResponse();
    return Object.freeze({ ...result.page });
  }

  renderPage(index: number, options: RenderPageOptions): Promise<RenderedDocumentPage> {
    this.assertOpen();
    this.assertPage(index);
    const cssWidth = positiveFinite(options.cssWidth, "cssWidth");
    const dpr = options.devicePixelRatio ?? 1;
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr > 2) {
      return Promise.reject(new DocumentPreviewError("RESOURCE_LIMIT", "devicePixelRatio must be greater than 0 and no more than 2"));
    }
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const cached = this.cache.get(index);
    if (cached !== undefined && cached.width === pixelWidth) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return Promise.resolve(copyPage(cached));
    }
    const task = async (): Promise<RenderedDocumentPage> => {
      this.assertOpen();
      const result = await this.rpc.request(
        { operation: "renderPage", sessionId: this.sessionId, pageIndex: index, pixelWidth },
        [],
        options.signal,
      );
      if (result.operation !== "renderPage") throw invalidResponse();
      validateRenderedPage(result.page, index, this.maxPagePixels);
      this.remember(result.page);
      return copyPage(result.page);
    };
    const result = this.renderQueue.then(task, task);
    this.renderQueue = result.then(() => undefined, () => undefined);
    return raceAbort(result, options.signal);
  }

  getDiagnostics(): readonly DocumentDiagnostic[] {
    return Object.freeze([...this.diagnostics]);
  }

  subscribe(listener: (diagnostic: DocumentDiagnostic) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.cache.clear();
    this.cacheBytes = 0;
    this.listeners.clear();
    this.onClose();
    this.rpc.bumpGeneration();
    this.closePromise = closeWorker(this.rpc, this.sessionId);
    return this.closePromise;
  }

  private remember(page: RenderedDocumentPage): void {
    const bytes = page.pixels.byteLength;
    if (bytes > this.pageCacheBytes) return;
    const previous = this.cache.get(page.pageIndex);
    if (previous !== undefined) this.cacheBytes -= previous.pixels.byteLength;
    this.cache.delete(page.pageIndex);
    this.cache.set(page.pageIndex, copyPage(page));
    this.cacheBytes += bytes;
    while (this.cache.size > 3 || this.cacheBytes > this.pageCacheBytes) {
      const oldest = this.cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      const removed = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (removed !== undefined) this.cacheBytes -= removed.pixels.byteLength;
    }
  }

  private emit(diagnostic: DocumentDiagnostic): void {
    const safe = Object.freeze({ ...diagnostic });
    this.diagnostics.push(safe);
    for (const listener of this.listeners) {
      try { listener(safe); } catch (error) { globalThis.reportError?.(error); }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw closedError();
  }

  private assertPage(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.pageCount) {
      throw new RangeError(`page index ${index} is outside 0..${this.pageCount - 1}`);
    }
  }
}

class Engine implements DocumentEngine {
  private closed = false;
  private readonly sessions = new Set<Session>();
  private readonly opening = new Set<RpcClient>();

  constructor(private readonly options: NormalizedOptions) {}

  async open(source: LocalDocumentSource, options: OpenDocumentOptions = {}): Promise<PagedDocumentSession> {
    if (this.closed) throw closedError();
    if (options.signal?.aborted === true) throw cancelledError();
    if (!(source instanceof ArrayBuffer) && !(typeof Blob !== "undefined" && source instanceof Blob)) {
      throw new TypeError("source must be a local Blob, File, or ArrayBuffer");
    }
    const size = source instanceof ArrayBuffer ? source.byteLength : source.size;
    if (size > this.options.maxInputBytes) throw limitError("input", size, this.options.maxInputBytes);
    const head = new Uint8Array(await readHead(source));
    const provider = this.options.providers.find((candidate) => candidate.sniff(head, options.sourceName));
    if (provider === undefined) {
      throw new DocumentPreviewError("UNSUPPORTED_FORMAT", "No registered document provider accepts this local source");
    }
    const bytes = source instanceof ArrayBuffer ? source.slice(0) : await raceAbort(source.arrayBuffer(), options.signal);
    const worker = provider.createWorker();
    const rpc = new RpcClient(worker);
    this.opening.add(rpc);
    const sessionId = crypto.randomUUID?.() ?? `document-${Date.now()}-${Math.random()}`;
    try {
      await raceAbort(rpc.hello(), options.signal);
      if (this.closed) throw closedError();
      const result = await rpc.request({
        operation: "open",
        sessionId,
        format: provider.format,
        bytes,
        limits: workerLimits(this.options),
        ...(this.options.assetBaseUrl === undefined ? {} : { assetBaseUrl: this.options.assetBaseUrl.href }),
      }, [bytes], options.signal);
      if (result.operation !== "open") throw invalidResponse();
      if (!Number.isSafeInteger(result.pageCount) || result.pageCount <= 0 || result.pageCount > this.options.maxPages) {
        throw limitError("pages", result.pageCount, this.options.maxPages);
      }
      let session!: Session;
      session = new Session(
        provider.format,
        result.pageCount,
        result.capabilities,
        sessionId,
        rpc,
        this.options.pageCacheBytes,
        this.options.maxPagePixels,
        () => this.sessions.delete(session),
      );
      this.sessions.add(session);
      this.opening.delete(rpc);
      return session;
    } catch (error) {
      this.opening.delete(rpc);
      rpc.terminate();
      throw asDocumentError(error, "PARSE_FAILED");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const rpc of this.opening) rpc.terminate();
    this.opening.clear();
    await Promise.allSettled([...this.sessions].map((session) => session.close()));
    this.sessions.clear();
  }
}

export async function createDocumentEngine(options: DocumentEngineOptions): Promise<DocumentEngine> {
  return new Engine(normalizeOptions(options));
}

function normalizeOptions(options: DocumentEngineOptions): NormalizedOptions {
  if (!Array.isArray(options.providers) || options.providers.length === 0) {
    throw new TypeError("providers must contain at least one local document provider");
  }
  const providers = Object.freeze(options.providers.map((provider) => Object.freeze({ ...provider })));
  if (new Set(providers.map(({ format }) => format)).size !== providers.length) {
    throw new TypeError("only one provider may be registered for each document format");
  }
  const normalized = {
    providers,
    assetBaseUrl: options.assetBaseUrl,
    memoryBudgetBytes: safeLimit(options.memoryBudgetBytes, DEFAULTS.memoryBudgetBytes, "memoryBudgetBytes"),
    maxInputBytes: safeLimit(options.maxInputBytes, DEFAULTS.maxInputBytes, "maxInputBytes"),
    pageCacheBytes: safeLimit(options.pageCacheBytes, DEFAULTS.pageCacheBytes, "pageCacheBytes"),
    maxPagePixels: safeLimit(options.maxPagePixels, DEFAULTS.maxPagePixels, "maxPagePixels"),
    maxPages: safeLimit(options.maxPages, DEFAULTS.maxPages, "maxPages"),
    maxIntermediateBytes: safeLimit(options.maxIntermediateBytes, DEFAULTS.maxIntermediateBytes, "maxIntermediateBytes"),
  };
  if (normalized.maxInputBytes + normalized.pageCacheBytes > normalized.memoryBudgetBytes) {
    throw new RangeError("maxInputBytes plus pageCacheBytes exceeds memoryBudgetBytes");
  }
  return Object.freeze(normalized);
}

async function readHead(source: LocalDocumentSource): Promise<ArrayBuffer> {
  const length = Math.min(source instanceof ArrayBuffer ? source.byteLength : source.size, 4096);
  return source instanceof ArrayBuffer ? source.slice(0, length) : source.slice(0, length).arrayBuffer();
}

function workerLimits(options: NormalizedOptions): WorkerLimits {
  return {
    memoryBudgetBytes: options.memoryBudgetBytes,
    maxInputBytes: options.maxInputBytes,
    maxIntermediateBytes: options.maxIntermediateBytes,
    maxPagePixels: options.maxPagePixels,
    maxPages: options.maxPages,
  };
}

async function closeWorker(rpc: RpcClient, sessionId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_900); });
  try {
    await Promise.race([
      rpc.request({ operation: "close", sessionId })
        .then(() => rpc.request({ operation: "shutdown" }))
        .then(() => undefined),
      timeout,
    ]);
  } catch { /* hard termination below is the cleanup boundary */ }
  if (timer !== undefined) clearTimeout(timer);
  rpc.terminate();
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(cancelledError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return value;
}

function safeLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return result;
}

function limitError(resource: string, requiredBytes: number, availableBytes: number): DocumentPreviewError {
  return new DocumentPreviewError("RESOURCE_LIMIT", `The document exceeds the ${resource} limit`, {
    details: { resource, requiredBytes, availableBytes },
  });
}

function invalidResponse(): DocumentPreviewError {
  return new DocumentPreviewError("PROTOCOL_INCOMPATIBLE", "The document Worker returned an unexpected response");
}

function validateRenderedPage(page: RenderedDocumentPage, index: number, maxPixels: number): void {
  if (page.pageIndex !== index || !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height)
    || page.width <= 0 || page.height <= 0 || page.width * page.height > maxPixels
    || page.stride !== page.width * 4 || page.pixels.byteLength !== page.stride * page.height
    || page.colorSpace !== "srgb") {
    throw new DocumentPreviewError("RENDER_FAILED", "The document Worker returned invalid page pixels");
  }
}

function copyPage(page: RenderedDocumentPage): RenderedDocumentPage {
  return Object.freeze({ ...page, pixels: page.pixels.slice(0) });
}
