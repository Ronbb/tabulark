import type { PreviewFormat } from "./types.js";

const extensions: Readonly<Record<string, PreviewFormat>> = Object.freeze({
  json: "json", jsonl: "jsonl", ndjson: "jsonl", yaml: "yaml", yml: "yaml", xml: "xml", toml: "toml",
  txt: "text", md: "markdown", markdown: "markdown", log: "log", ini: "ini", env: "env", conf: "text", cfg: "text", properties: "properties",
  js: "code", mjs: "code", cjs: "code", jsx: "code", ts: "code", tsx: "code", css: "code", html: "code", htm: "code", py: "code", rb: "code", rs: "code", go: "code", java: "code", c: "code", h: "code", cpp: "code", hpp: "code", cs: "code", sh: "code", ps1: "code", sql: "code",
  png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", svg: "svg", bmp: "bmp", tif: "tiff", tiff: "tiff", heic: "heic", heif: "heic", pdf: "pdf",
});
export function detectFormat(head: Uint8Array, sourceName?: string): PreviewFormat | undefined {
  if (starts(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "webp";
  if (starts(head, [0x42, 0x4d])) return "bmp";
  if (starts(head, [0x49, 0x49, 0x2a, 0x00]) || starts(head, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(head, 4, 4) === "ftyp" && /^(?:hei[cf]|mif1|msf1)$/.test(ascii(head, 8, 4))) return "heic";
  const hint = extensionFormat(sourceName);
  const text = decodeHead(head).trimStart();
  if (text.startsWith("<svg") || /^<\?xml[^>]*>\s*<svg\b/i.test(text)) return "svg";
  if (text.startsWith("<?xml") || /^<[A-Za-z_][\w:.-]*(?:\s|>|\/)/.test(text)) return hint === "svg" ? "svg" : "xml";
  if (hint && isStructured(hint)) return hint;
  if (looksJson(text)) return text.includes("\n") && looksJsonLines(text) ? "jsonl" : "json";
  if (hint !== undefined && isTextual(hint)) return hint;
  if (isProbablyText(head)) return "text";
  return hint !== undefined && isImage(hint) ? hint : undefined;
}
export function extensionFormat(name?: string): PreviewFormat | undefined {
  if (!name) return undefined;
  const clean = name.split(/[?#]/, 1)[0] ?? name;
  const index = clean.lastIndexOf(".");
  return index < 0 ? undefined : extensions[clean.slice(index + 1).toLowerCase()];
}
export function isStructured(format: PreviewFormat): boolean { return ["json", "jsonl", "yaml", "xml", "toml"].includes(format); }
export function isImage(format: PreviewFormat): boolean { return ["png", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic"].includes(format); }
export function isTextual(format: PreviewFormat): boolean { return isStructured(format) || ["text", "markdown", "log", "ini", "env", "properties", "code"].includes(format); }
function starts(bytes: Uint8Array, signature: readonly number[]): boolean { return signature.every((byte, index) => bytes[index] === byte); }
function ascii(bytes: Uint8Array, offset: number, length: number): string { return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
function decodeHead(bytes: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch { return ""; } }
function looksJson(text: string): boolean { return text.startsWith("{") || text.startsWith("[") || text === "null"; }
function looksJsonLines(text: string): boolean { const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 4); return lines.length > 1 && lines.every((line) => { try { JSON.parse(line); return true; } catch { return false; } }); }
function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (starts(bytes, [0xff, 0xfe]) || starts(bytes, [0xfe, 0xff]) || starts(bytes, [0xef, 0xbb, 0xbf])) return true;
  let controls = 0;
  for (const byte of bytes) if (byte === 0 || byte < 0x09 || byte > 0x0d && byte < 0x20) controls += 1;
  return controls / bytes.length < 0.02;
}
