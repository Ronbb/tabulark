import { PreviewError, resourceLimit } from "./errors.js";
import type { PreviewFormat } from "./types.js";

export interface ImageInfo { readonly width?: number; readonly height?: number; readonly frameCount?: number; readonly mediaType: string }
export function inspectImage(format: PreviewFormat, bytes: Uint8Array, maxPixels: number): ImageInfo {
  let width: number | undefined, height: number | undefined, frameCount: number | undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "png" && bytes.length >= 24) { width = view.getUint32(16); height = view.getUint32(20); }
  else if (format === "gif" && bytes.length >= 10) { width = view.getUint16(6, true); height = view.getUint16(8, true); frameCount = count(bytes, [0x2c]); }
  else if (format === "bmp" && bytes.length >= 26) { width = Math.abs(view.getInt32(18, true)); height = Math.abs(view.getInt32(22, true)); }
  else if (format === "jpeg") ({ width, height } = jpegSize(bytes));
  else if (format === "webp") ({ width, height } = webpSize(bytes));
  else if (format === "svg") ({ width, height } = validateSvg(bytes));
  if (width !== undefined && height !== undefined) { const pixels = width * height; if (!Number.isSafeInteger(pixels) || pixels > maxPixels) throw resourceLimit("image-pixels", pixels, maxPixels); }
  return { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }), ...(frameCount === undefined ? {} : { frameCount }), mediaType: mediaType(format) };
}
function jpegSize(bytes: Uint8Array): { width?: number; height?: number } { let offset = 2; while (offset + 9 < bytes.length) { if (bytes[offset] !== 0xff) { offset += 1; continue; } const marker = bytes[offset + 1]!; if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { height: bytes[offset + 5]! << 8 | bytes[offset + 6]!, width: bytes[offset + 7]! << 8 | bytes[offset + 8]! }; const length = bytes[offset + 2]! << 8 | bytes[offset + 3]!; if (length < 2) break; offset += 2 + length; } return {}; }
function webpSize(bytes: Uint8Array): { width?: number; height?: number } { const chunk = String.fromCharCode(...bytes.subarray(12, 16)); if (chunk === "VP8X" && bytes.length >= 30) return { width: 1 + uint24(bytes, 24), height: 1 + uint24(bytes, 27) }; if (chunk === "VP8L" && bytes.length >= 25) { const bits = bytes[21]! | bytes[22]! << 8 | bytes[23]! << 16 | bytes[24]! << 24; return { width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1 }; } return {}; }
function validateSvg(bytes: Uint8Array): { width?: number; height?: number } { const text = new TextDecoder().decode(bytes); if (/<script\b|\bon\w+\s*=|\b(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:text\/html)/i.test(text) || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new PreviewError("PARSE_FAILED", "SVG scripts, event handlers, external resources, and entities are disabled"); const open = /<svg\b([^>]*)>/i.exec(text); if (!open) throw new PreviewError("PARSE_FAILED", "SVG root element is missing"); const width = numericAttribute(open[1]!, "width"), height = numericAttribute(open[1]!, "height"); return { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) }; }
function numericAttribute(attributes: string, name: string): number | undefined { const match = new RegExp(`\\b${name}\\s*=\\s*["']([0-9]+(?:\\.[0-9]+)?)(?:px)?["']`, "i").exec(attributes); if (!match) return undefined; const value = Number(match[1]); return Number.isFinite(value) && value > 0 ? value : undefined; }
function mediaType(format: PreviewFormat): string { return ({ jpeg: "image/jpeg", svg: "image/svg+xml", tiff: "image/tiff", heic: "image/heic" } as Record<string, string>)[format] ?? `image/${format}`; }
function uint24(bytes: Uint8Array, offset: number): number { return bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16; }
function count(bytes: Uint8Array, signature: readonly number[]): number { let total = 0; for (let index = 0; index <= bytes.length - signature.length; index += 1) if (signature.every((byte, part) => bytes[index + part] === byte)) total += 1; return total; }
