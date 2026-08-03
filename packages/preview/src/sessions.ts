import { closed, PreviewError, resourceLimit } from "./errors.js";
import type { ImageSession, PreviewCapabilities, PreviewDiagnostic, PreviewFormat, PreviewMetadata, StructuredNode, StructuredNodeType, StructuredSession, TableProjection, TextLine, TextRange, TextSearchMatch, TextSession } from "./types.js";

const baseCapabilities: PreviewCapabilities = Object.freeze({ localOnly: true, remoteRange: false, search: false, pagination: false, tree: false, tableProjection: false, zoom: false });
abstract class BaseSession {
  abstract readonly kind: "text" | "structured" | "image";
  readonly capabilities: PreviewCapabilities;
  private isClosed = false;
  private readonly diagnostics: PreviewDiagnostic[] = [];
  private readonly listeners = new Set<(diagnostic: PreviewDiagnostic) => void>();
  constructor(readonly format: PreviewFormat, readonly metadata: PreviewMetadata, capabilities: Partial<PreviewCapabilities>, private readonly release: () => Promise<void>) {
    this.capabilities = Object.freeze({ ...baseCapabilities, ...capabilities });
  }
  getDiagnostics(): readonly PreviewDiagnostic[] { return Object.freeze([...this.diagnostics]); }
  subscribe(listener: (diagnostic: PreviewDiagnostic) => void): () => void { this.assertOpen(); this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { if (this.isClosed) return; this.isClosed = true; this.listeners.clear(); await this.release(); }
  protected assertOpen(): void { if (this.isClosed) throw closed(); }
}

export class LocalTextSession extends BaseSession implements TextSession {
  readonly kind = "text" as const;
  readonly lineCount: number;
  private readonly starts: number[];
  constructor(format: PreviewFormat, metadata: PreviewMetadata, private text: string, private readonly maxSearchResults: number, release: () => Promise<void>) {
    super(format, metadata, { search: true, remoteRange: metadata.remoteRange === true }, release);
    this.starts = lineStarts(text); this.lineCount = this.starts.length;
  }
  getText(range?: TextRange): string { this.assertOpen(); if (!range) return this.text; validateTextRange(range, this.text.length); return this.text.slice(range.offset, range.offset + range.length); }
  getLines(offset: number, limit: number): readonly TextLine[] {
    this.assertOpen(); validatePage(offset, limit, this.lineCount);
    return Object.freeze(this.starts.slice(offset, offset + limit).map((start, index) => {
      const lineIndex = offset + index; const rawEnd = this.starts[lineIndex + 1] ?? this.text.length; const end = trimNewline(this.text, start, rawEnd);
      return Object.freeze({ number: lineIndex + 1, text: this.text.slice(start, end), start, end });
    }));
  }
  search(query: string, options: { readonly caseSensitive?: boolean; readonly maxResults?: number } = {}): readonly TextSearchMatch[] {
    this.assertOpen(); if (query.length === 0 || query.length > 1024) throw new RangeError("query must contain 1 to 1024 characters");
    const maximum = options.maxResults ?? this.maxSearchResults; if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > this.maxSearchResults) throw new RangeError("maxResults exceeds the search limit");
    const haystack = options.caseSensitive ? this.text : this.text.toLocaleLowerCase(); const needle = options.caseSensitive ? query : query.toLocaleLowerCase(); const matches: TextSearchMatch[] = [];
    let cursor = 0; while (matches.length < maximum) { const start = haystack.indexOf(needle, cursor); if (start < 0) break; const lineIndex = findLine(this.starts, start); const lineStart = this.starts[lineIndex] ?? 0; const lineEnd = trimNewline(this.text, lineStart, this.starts[lineIndex + 1] ?? this.text.length); matches.push(Object.freeze({ start, end: start + query.length, line: lineIndex + 1, preview: this.text.slice(lineStart, lineEnd).slice(0, 500) })); cursor = start + Math.max(1, needle.length); }
    return Object.freeze(matches);
  }
}

interface NodeRecord { readonly public: StructuredNode; readonly value: unknown; readonly children: readonly number[] }
export class LocalStructuredSession extends BaseSession implements StructuredSession {
  readonly kind = "structured" as const; readonly rootId = 0; private readonly nodes: readonly NodeRecord[];
  constructor(format: PreviewFormat, metadata: PreviewMetadata, private raw: string, value: unknown, limits: { maxNodes: number; maxDepth: number }, release: () => Promise<void>) {
    super(format, metadata, { tree: true, tableProjection: true, remoteRange: metadata.remoteRange === true }, release); this.nodes = buildNodes(value, limits);
  }
  getNodes(offset: number, limit: number): readonly StructuredNode[] { this.assertOpen(); validatePage(offset, limit, this.nodes.length); return Object.freeze(this.nodes.slice(offset, offset + limit).map((node) => node.public)); }
  getChildren(nodeId: number, offset = 0, limit = 100): readonly StructuredNode[] { this.assertOpen(); const node = this.node(nodeId); validatePage(offset, limit, node.children.length); return Object.freeze(node.children.slice(offset, offset + limit).map((id) => this.nodes[id]!.public)); }
  projectArray(nodeId: number, options: { readonly offset?: number; readonly limit?: number } = {}): TableProjection {
    this.assertOpen(); const value = this.node(nodeId).value; if (!Array.isArray(value) || !value.every(isPlainRecord)) throw new PreviewError("PARSE_FAILED", "Only homogeneous arrays of objects can be projected as a table");
    const columns = [...new Set(value.flatMap((row) => Object.keys(row)))]; if (!value.every((row) => Object.keys(row).every((key) => columns.includes(key)))) throw new PreviewError("PARSE_FAILED", "The array is not homogeneous");
    const offset = options.offset ?? 0, limit = options.limit ?? 100; validatePage(offset, limit, value.length);
    return Object.freeze({ columns: Object.freeze(columns), rows: Object.freeze(value.slice(offset, offset + limit).map((row) => Object.freeze({ ...row }))) });
  }
  getRawText(range?: TextRange): string { this.assertOpen(); if (!range) return this.raw; validateTextRange(range, this.raw.length); return this.raw.slice(range.offset, range.offset + range.length); }
  private node(id: number): NodeRecord { if (!Number.isSafeInteger(id) || id < 0 || id >= this.nodes.length) throw new RangeError("structured node does not exist"); return this.nodes[id]!; }
}

export class LocalImageSession extends BaseSession implements ImageSession {
  readonly kind = "image" as const;
  readonly width?: number;
  readonly height?: number;
  readonly frameCount?: number;
  constructor(format: PreviewFormat, metadata: PreviewMetadata, private blob: Blob, width: number | undefined, height: number | undefined, frameCount: number | undefined, release: () => Promise<void>) { super(format, metadata, { zoom: true, remoteRange: metadata.remoteRange === true }, release); if (width !== undefined) this.width = width; if (height !== undefined) this.height = height; if (frameCount !== undefined) this.frameCount = frameCount; }
  getBlob(): Blob { this.assertOpen(); return this.blob.slice(0, this.blob.size, this.blob.type); }
}

function buildNodes(root: unknown, limits: { maxNodes: number; maxDepth: number }): readonly NodeRecord[] {
  const nodes: NodeRecord[] = [];
  const add = (value: unknown, depth: number, parentId?: number, key?: string | number): number => {
    if (depth > limits.maxDepth) throw resourceLimit("structured-depth", depth, limits.maxDepth); if (nodes.length >= limits.maxNodes) throw resourceLimit("structured-nodes", nodes.length + 1, limits.maxNodes);
    const id = nodes.length; const children: number[] = []; const type = nodeType(value); const publicNode: StructuredNode = Object.freeze({ id, ...(parentId === undefined ? {} : { parentId }), ...(key === undefined ? {} : { key }), type, ...(type === "object" || type === "array" ? {} : { value: value as string | number | boolean | null }), childCount: type === "array" ? (value as unknown[]).length : type === "object" ? Object.keys(value as object).length : 0, depth });
    nodes.push({ public: publicNode, value, children });
    if (Array.isArray(value)) value.forEach((child, index) => children.push(add(child, depth + 1, id, index)));
    else if (isPlainRecord(value)) for (const [childKey, child] of Object.entries(value)) children.push(add(child, depth + 1, id, childKey));
    return id;
  }; add(root, 0); return Object.freeze(nodes);
}
function nodeType(value: unknown): StructuredNodeType { if (value === null) return "null"; if (Array.isArray(value)) return "array"; if (isPlainRecord(value)) return "object"; if (["string", "number", "boolean"].includes(typeof value)) return typeof value as StructuredNodeType; return "string"; }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function lineStarts(text: string): number[] { const starts = [0]; for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1); return starts; }
function trimNewline(text: string, start: number, end: number): number { let result = end; if (result > start && text.charCodeAt(result - 1) === 10) result -= 1; if (result > start && text.charCodeAt(result - 1) === 13) result -= 1; return result; }
function findLine(starts: readonly number[], offset: number): number { let low = 0, high = starts.length; while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle]! <= offset) low = middle; else high = middle; } return low; }
function validateTextRange(range: TextRange, length: number): void { if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 0 || range.offset > length || range.length > length - range.offset) throw new RangeError("text range is outside the preview"); }
function validatePage(offset: number, limit: number, length: number): void { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0 || offset > length || limit < 1 || limit > 10_000) throw new RangeError("preview range is invalid"); }
