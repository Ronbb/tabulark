import { detectFormat, isImage, isStructured, isTextual } from "./detect.js";
import { cancelled, closed, PreviewError, resourceLimit } from "./errors.js";
import { inspectInWorker } from "./worker-client.js";
import { isOfficialProvider, officialPreviewProviders } from "./providers.js";
import { LocalImageSession, LocalStructuredSession, LocalTextSession } from "./sessions.js";
import { openSource } from "./source.js";
import type { PreviewEngine, PreviewEngineOptions, PreviewFormat, PreviewLimits, PreviewOpenOptions, PreviewProvider, PreviewSession, PreviewSource } from "./types.js";

const MiB = 1024 * 1024;
const defaults = Object.freeze({ maxSourceBytes: Number.MAX_SAFE_INTEGER, maxInputBytes: 32 * MiB, maxTextBytes: 16 * MiB, maxTextLines: 1_000_000, maxSearchResults: 1_000, maxNodes: 100_000, maxDepth: 100, maxImagePixels: 32_000_000, maxRangeConcurrency: 2 });
type NormalizedLimits = Required<PreviewLimits>;

class Engine implements PreviewEngine {
  private isClosed = false; private readonly sessions = new Set<PreviewSession>();
  constructor(private readonly providers: readonly PreviewProvider[], private readonly limits: NormalizedLimits) {}
  async open(source: PreviewSource, options: PreviewOpenOptions = {}): Promise<PreviewSession> {
    if (this.isClosed) throw closed(); if (options.signal?.aborted) throw cancelled();
    const opened = await openSource(source, this.limits, options.signal); let handedOff = false;
    try {
      const head = await opened.read(0, Math.min(opened.size, 4096), options.signal);
      const format = options.format === undefined || options.format === "auto" ? detectFormat(head, options.sourceName ?? opened.name) : options.format;
      if (!format) throw new PreviewError("UNSUPPORTED_FORMAT", "No bundled preview provider recognizes this source");
      const provider = this.providers.find((candidate) => candidate.formats.includes(format)); if (!provider) throw new PreviewError("UNSUPPORTED_FORMAT", `No enabled preview provider supports ${format}`);
      if (format === "pdf") throw new PreviewError("UNSUPPORTED_FORMAT", "PDF is available through @tabulark/document-preview until its worker provider is migrated");
      if (isTextual(format)) {
        if (opened.size > this.limits.maxTextBytes) throw resourceLimit("text-bytes", opened.size, this.limits.maxTextBytes);
        const workerResult = await inspectInWorker("text", format, await opened.read(0, opened.size, options.signal), this.limits.maxImagePixels, options.signal); const decoded = workerResult.decoded!; const lineCount = countLines(decoded.text); if (lineCount > this.limits.maxTextLines) throw resourceLimit("text-lines", lineCount, this.limits.maxTextLines);
        const metadata = Object.freeze({ size: opened.size, snapshot: opened.snapshot, remoteRange: opened.remoteRange, fidelity: isStructured(format) ? "semantic" as const : "exact" as const, encoding: decoded.encoding, ...(options.sourceName ?? opened.name ? { sourceName: options.sourceName ?? opened.name } : {}) });
        const release = async (): Promise<void> => { this.sessions.delete(session); await opened.close(); };
        let session: PreviewSession;
        if (isStructured(format)) session = new LocalStructuredSession(format, metadata, decoded.text, workerResult.value, this.limits, release);
        else session = new LocalTextSession(format, metadata, decoded.text, this.limits.maxSearchResults, release);
        this.sessions.add(session); handedOff = true; return session;
      }
      if (isImage(format)) {
        if (opened.size > this.limits.maxInputBytes) throw resourceLimit("image-input-bytes", opened.size, this.limits.maxInputBytes);
        const bytes = await opened.read(0, opened.size, options.signal); const workerResult = await inspectInWorker("image", format, bytes, this.limits.maxImagePixels, options.signal); const info = workerResult.info!; const blob = new Blob([bytes.slice().buffer], { type: info.mediaType });
        const metadata = Object.freeze({ size: opened.size, snapshot: opened.snapshot, remoteRange: opened.remoteRange, fidelity: "exact" as const, mediaType: info.mediaType, ...(options.sourceName ?? opened.name ? { sourceName: options.sourceName ?? opened.name } : {}) });
        let session!: PreviewSession; const release = async (): Promise<void> => { this.sessions.delete(session); await opened.close(); }; session = new LocalImageSession(format, metadata, blob, info.width, info.height, info.frameCount, release); this.sessions.add(session); handedOff = true; return session;
      }
      throw new PreviewError("UNSUPPORTED_FORMAT", `The ${format} preview provider is not available in P0`);
    } catch (error) { if (options.signal?.aborted) throw cancelled(); throw error; }
    finally { if (!handedOff) await opened.close(); }
  }
  async close(): Promise<void> { if (this.isClosed) return; this.isClosed = true; await Promise.allSettled([...this.sessions].map((session) => session.close())); this.sessions.clear(); }
}
export function createPreviewEngine(options: PreviewEngineOptions = {}): PreviewEngine {
  const providers = options.providers ?? officialPreviewProviders;
  if (!Array.isArray(providers) || providers.length === 0 || !providers.every(isOfficialProvider)) throw new TypeError("providers must be selected from the bundled officialPreviewProviders manifest");
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new TypeError("providers may only be registered once");
  return new Engine(Object.freeze([...providers]), normalizeLimits(options.limits));
}
function normalizeLimits(value: PreviewLimits | undefined): NormalizedLimits {
  const result = { ...defaults, ...value }; for (const [name, limit] of Object.entries(result)) if (!Number.isSafeInteger(limit) || limit <= 0 || limit > Number.MAX_SAFE_INTEGER) throw new RangeError(`${name} must be a positive JavaScript safe integer`);
  if (result.maxInputBytes > result.maxSourceBytes || result.maxTextBytes > result.maxSourceBytes) throw new RangeError("input and text limits cannot exceed maxSourceBytes"); return Object.freeze(result);
}
function countLines(text: string): number { let lines = 1; for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1; return lines; }
