import { PreviewError } from "./errors.js";
import type { PreviewFormat } from "./types.js";

export interface DecodedText { readonly text: string; readonly encoding: "utf-8" | "utf-16le" | "utf-16be" }
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decodeUtf16Be(bytes.subarray(2)), encoding: "utf-16be" };
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start)), encoding: "utf-8" }; }
  catch (cause) { throw new PreviewError("PARSE_FAILED", "Text is not valid UTF-8 or BOM-marked UTF-16", { cause }); }
}
export function parseStructured(format: PreviewFormat, text: string): unknown {
  try {
    switch (format) {
      case "json": return JSON.parse(text);
      case "jsonl": return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, index) => { try { return JSON.parse(line); } catch (cause) { throw new PreviewError("PARSE_FAILED", `Invalid JSON on line ${index + 1}`, { cause }); } });
      case "yaml": return parseYaml(text);
      case "toml": return parseToml(text);
      case "xml": return parseXml(text);
      default: throw new PreviewError("UNSUPPORTED_FORMAT", `No structured parser is available for ${format}`);
    }
  } catch (error) { if (error instanceof PreviewError) throw error; throw new PreviewError("PARSE_FAILED", `The ${format.toUpperCase()} source is malformed`, { cause: error }); }
}

function parseYaml(text: string): unknown {
  if (/^(?:---\s*)?\s*[!&*]/m.test(text) || /<<\s*:/.test(text)) throw new PreviewError("PARSE_FAILED", "YAML tags, anchors, aliases, and merge keys are disabled");
  const meaningful = text.split(/\r?\n/).map((raw, number) => ({ raw, number: number + 1 })).filter(({ raw }) => raw.trim() && !raw.trimStart().startsWith("#"));
  if (meaningful.length === 0) return null;
  const rootIsArray = meaningful[0]!.raw.trimStart().startsWith("- "); const root: unknown[] | Record<string, unknown> = rootIsArray ? [] : Object.create(null);
  const stack: Array<{ indent: number; value: unknown[] | Record<string, unknown> }> = [{ indent: -1, value: root }];
  for (let index = 0; index < meaningful.length; index += 1) {
    const { raw, number } = meaningful[index]!; if (/\t/.test(raw.slice(0, raw.length - raw.trimStart().length))) throw new PreviewError("PARSE_FAILED", `Tabs are not allowed for YAML indentation on line ${number}`);
    const indent = raw.length - raw.trimStart().length; const content = stripYamlComment(raw.trim()); while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop(); const parent = stack.at(-1)!.value;
    if (content.startsWith("- ")) {
      if (!Array.isArray(parent)) throw new PreviewError("PARSE_FAILED", `Unexpected YAML sequence item on line ${number}`);
      const item = content.slice(2).trim(); const pair = splitPair(item);
      if (pair) { const object: Record<string, unknown> = Object.create(null); object[pair[0]] = pair[1] === "" ? childContainer(meaningful[index + 1]?.raw, indent) : scalar(pair[1]); parent.push(object); stack.push({ indent, value: object }); }
      else parent.push(scalar(item));
    } else {
      if (Array.isArray(parent)) throw new PreviewError("PARSE_FAILED", `Expected a YAML sequence item on line ${number}`); const pair = splitPair(content); if (!pair) throw new PreviewError("PARSE_FAILED", `Expected a YAML key/value pair on line ${number}`);
      if (Object.hasOwn(parent, pair[0])) throw new PreviewError("PARSE_FAILED", `Duplicate YAML key '${pair[0]}' on line ${number}`); const value = pair[1] === "" ? childContainer(meaningful[index + 1]?.raw, indent) : scalar(pair[1]); parent[pair[0]] = value; if (typeof value === "object" && value !== null) stack.push({ indent, value: value as unknown[] | Record<string, unknown> });
    }
  }
  return root;
}
function parseToml(text: string): unknown {
  const root: Record<string, unknown> = Object.create(null); let current = root;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = stripQuotedComment(raw, "#").trim(); if (!line) continue;
    const table = /^\[([^\[\]]+)\]$/.exec(line); if (table) { current = root; for (const part of table[1]!.split(".").map(unquoteKey)) { const existing = current[part]; if (existing === undefined) current[part] = Object.create(null); else if (typeof existing !== "object" || existing === null || Array.isArray(existing)) throw new PreviewError("PARSE_FAILED", `Invalid TOML table on line ${index + 1}`); current = current[part] as Record<string, unknown>; } continue; }
    if (/^\[\[/.test(line)) throw new PreviewError("PARSE_FAILED", "TOML arrays of tables are not supported by the bounded P0 parser");
    const equals = unquotedIndex(line, "="); if (equals < 1) throw new PreviewError("PARSE_FAILED", `Invalid TOML assignment on line ${index + 1}`); const key = unquoteKey(line.slice(0, equals).trim()); if (Object.hasOwn(current, key)) throw new PreviewError("PARSE_FAILED", `Duplicate TOML key '${key}' on line ${index + 1}`); current[key] = scalar(line.slice(equals + 1).trim());
  }
  return root;
}
function parseXml(text: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new PreviewError("PARSE_FAILED", "XML document types and entities are disabled");
  const tokens = text.replace(/^\uFEFF/, "").match(/<\?[^?]*\?>|<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<[^>]+>|[^<]+/g) ?? [];
  type Element = { name: string; attributes: Record<string, string>; children: Array<Element | string> }; const stack: Element[] = []; let root: Element | undefined;
  for (const token of tokens) {
    if (token.startsWith("<?") || token.startsWith("<!--")) continue;
    if (token.startsWith("<![CDATA[")) { if (!stack.length) throw new PreviewError("PARSE_FAILED", "XML CDATA appears outside the root element"); stack.at(-1)!.children.push(token.slice(9, -3)); continue; }
    if (token.startsWith("</")) { const name = token.slice(2, -1).trim(); if (stack.pop()?.name !== name) throw new PreviewError("PARSE_FAILED", `Mismatched XML closing tag ${name}`); continue; }
    if (token.startsWith("<")) { const selfClosing = /\/\s*>$/.test(token); const body = token.slice(1, selfClosing ? token.lastIndexOf("/") : -1).trim(); const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(body); if (!nameMatch) throw new PreviewError("PARSE_FAILED", "Invalid XML element name"); const element: Element = { name: nameMatch[0], attributes: parseAttributes(body.slice(nameMatch[0].length)), children: [] }; if (stack.length) stack.at(-1)!.children.push(element); else if (root) throw new PreviewError("PARSE_FAILED", "XML contains multiple root elements"); else root = element; if (!selfClosing) stack.push(element); continue; }
    if (token.trim()) { if (!stack.length) throw new PreviewError("PARSE_FAILED", "XML text appears outside the root element"); stack.at(-1)!.children.push(token); }
  }
  if (!root || stack.length) throw new PreviewError("PARSE_FAILED", "XML is truncated or has no root element"); return root;
}
function parseAttributes(value: string): Record<string, string> { const attributes: Record<string, string> = Object.create(null); const pattern = /\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g; let match: RegExpExecArray | null; let consumed = ""; while ((match = pattern.exec(value))) { attributes[match[1]!] = decodeEntities(match[2]!.slice(1, -1)); consumed += match[0]; } if (value.replace(pattern, "").trim()) throw new PreviewError("PARSE_FAILED", "Malformed or unquoted XML attribute"); void consumed; return attributes; }
function decodeEntities(value: string): string { return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name]!).replace(/&(#\d+|#x[\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code.slice(code[1]?.toLowerCase() === "x" ? 2 : 1), code[1]?.toLowerCase() === "x" ? 16 : 10))).replace(/&[^;\s]+;/g, () => { throw new PreviewError("PARSE_FAILED", "Unknown XML entity reference"); }); }
function scalar(value: string): unknown { const trimmed = value.trim(); if (trimmed === "null" || trimmed === "~") return null; if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true"; if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) { const number = Number(trimmed); if (Number.isFinite(number)) return number; } if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1); if (trimmed.startsWith("[") && trimmed.endsWith("]")) return splitComma(trimmed.slice(1, -1)).map(scalar); return trimmed; }
function splitPair(value: string): [string, string] | undefined { const index = unquotedIndex(value, ":"); return index <= 0 ? undefined : [unquoteKey(value.slice(0, index).trim()), value.slice(index + 1).trim()]; }
function childContainer(nextRaw: string | undefined, indent: number): unknown[] | Record<string, unknown> { if (!nextRaw) return Object.create(null); const nextIndent = nextRaw.length - nextRaw.trimStart().length; return nextIndent > indent && nextRaw.trimStart().startsWith("- ") ? [] : Object.create(null); }
function stripYamlComment(value: string): string { return stripQuotedComment(value, "#").trimEnd(); }
function stripQuotedComment(value: string, marker: string): string { let quote = ""; for (let index = 0; index < value.length; index += 1) { const char = value[index]!; if ((char === '"' || char === "'") && value[index - 1] !== "\\") quote = quote === char ? "" : quote || char; if (!quote && char === marker && (index === 0 || /\s/.test(value[index - 1]!))) return value.slice(0, index); } return value; }
function unquotedIndex(value: string, target: string): number { let quote = ""; for (let index = 0; index < value.length; index += 1) { const char = value[index]!; if ((char === '"' || char === "'") && value[index - 1] !== "\\") quote = quote === char ? "" : quote || char; else if (!quote && char === target) return index; } return -1; }
function unquoteKey(value: string): string { const key = value.trim().replace(/^("([^"]*)"|'([^']*)')$/, "$2$3"); if (!key || key === "__proto__" || key === "prototype" || key === "constructor") throw new PreviewError("PARSE_FAILED", "Unsafe or empty structured key"); return key; }
function splitComma(value: string): string[] { const parts: string[] = []; let start = 0, quote = ""; for (let index = 0; index < value.length; index += 1) { const char = value[index]!; if ((char === '"' || char === "'") && value[index - 1] !== "\\") quote = quote === char ? "" : quote || char; else if (!quote && char === ",") { parts.push(value.slice(start, index)); start = index + 1; } } parts.push(value.slice(start)); return parts.filter((part) => part.trim()); }
function decodeUtf16Be(bytes: Uint8Array): string { const swapped = bytes.slice(); for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1]!, swapped[index]!]; return new TextDecoder("utf-16le").decode(swapped); }
