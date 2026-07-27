const TABLE_EXTENSIONS = Object.freeze({
  csv: "csv", tsv: "tsv", arrow: "arrow", arrows: "arrow", feather: "arrow",
  parquet: "parquet", xls: "xls", xlsx: "xlsx",
});

const DOCUMENT_EXTENSIONS = Object.freeze({ pdf: "pdf", docx: "docx", doc: "doc" });

const MIME_FORMATS = Object.freeze({
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/vnd.apache.arrow.file": "arrow",
  "application/vnd.apache.arrow.stream": "arrow",
  "application/vnd.apache.arrow.feather": "arrow",
  "application/vnd.apache.arrow": "arrow",
  "application/vnd.apache.parquet": "parquet",
  "application/x-parquet": "parquet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
});

/**
 * Returns a safe local route. Container structure wins over filename/MIME,
 * and an unknown binary is never sent to the delimited-text adapter.
 */
export async function detectLocalFormat(source) {
  if (!isBlobLike(source)) return undefined;
  const metadata = metadataFormat(source);
  const head = new Uint8Array(await source.slice(0, Math.min(source.size, 512)).arrayBuffer());
  if (asciiAt(head, "%PDF-")) return "pdf";
  if (asciiAt(head, "PAR1")) return "parquet";
  if (asciiAt(head, "ARROW1")) return "arrow";
  if (bytesAt(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return await detectCfbFormat(source);
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    return await detectZipFormat(source);
  }
  if (source.size >= 6) {
    const tail = new Uint8Array(await source.slice(source.size - 6).arrayBuffer());
    if (asciiAt(tail, "ARROW1")) return "arrow";
  }
  if (looksBinary(head)) return "unknown-binary";
  return metadata ?? "csv";
}

export function metadataFormat(source) {
  const name = typeof source?.name === "string" ? source.name : "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    const extension = name.slice(dot + 1).toLowerCase();
    if (Object.hasOwn(TABLE_EXTENSIONS, extension)) return TABLE_EXTENSIONS[extension];
    if (Object.hasOwn(DOCUMENT_EXTENSIONS, extension)) return DOCUMENT_EXTENSIONS[extension];
  }
  const mime = typeof source?.type === "string" ? source.type.split(";", 1)[0].trim().toLowerCase() : "";
  return Object.hasOwn(MIME_FORMATS, mime) ? MIME_FORMATS[mime] : undefined;
}

async function detectZipFormat(source) {
  // The EOCD and comment occupy at most 65,557 bytes. Reading only this tail
  // avoids inflating OOXML ZIP entries merely to route the file.
  const tailStart = Math.max(0, source.size - 65_557);
  const tail = new Uint8Array(await source.slice(tailStart).arrayBuffer());
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > tail.length) return "unknown-binary";
  let entries = view.getUint16(eocd + 10, true);
  let directoryBytes = view.getUint32(eocd + 12, true);
  let directoryOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(view, locator) !== 0x07064b50) return "unknown-binary";
    const zip64Offset = safeBigUint(view, locator + 8);
    if (zip64Offset === undefined || zip64Offset + 56 > source.size) return "unknown-binary";
    const zip64Bytes = new Uint8Array(await source.slice(zip64Offset, zip64Offset + 56).arrayBuffer());
    const zip64 = new DataView(zip64Bytes.buffer, zip64Bytes.byteOffset, zip64Bytes.byteLength);
    if (u32(zip64, 0) !== 0x06064b50) return "unknown-binary";
    entries = safeBigUint(zip64, 32) ?? Number.MAX_SAFE_INTEGER;
    directoryBytes = safeBigUint(zip64, 40) ?? Number.MAX_SAFE_INTEGER;
    directoryOffset = safeBigUint(zip64, 48) ?? Number.MAX_SAFE_INTEGER;
  }
  if (entries > 4096 || directoryBytes > 4 * 1024 * 1024 || directoryOffset + directoryBytes > source.size) {
    return "unknown-binary";
  }
  const directory = new Uint8Array(await source.slice(directoryOffset, directoryOffset + directoryBytes).arrayBuffer());
  const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  let offset = 0;
  let word = false;
  let excel = false;
  for (let index = 0; index < entries && offset + 46 <= directory.length; index += 1) {
    if (u32(directoryView, offset) !== 0x02014b50) return "unknown-binary";
    const nameLength = directoryView.getUint16(offset + 28, true);
    const extraLength = directoryView.getUint16(offset + 30, true);
    const commentLength = directoryView.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength;
    if (end > directory.length) return "unknown-binary";
    const name = new TextDecoder().decode(directory.subarray(offset + 46, end)).replaceAll("\\", "/").toLowerCase();
    if (name === "word/document.xml") word = true;
    if (name === "xl/workbook.xml") excel = true;
    offset = end + extraLength + commentLength;
  }
  if (word && !excel) return "docx";
  if (excel && !word) return "xlsx";
  return "unknown-binary";
}

async function detectCfbFormat(source) {
  const headerBytes = new Uint8Array(await source.slice(0, Math.min(source.size, 512)).arrayBuffer());
  if (headerBytes.length < 512) return "unknown-binary";
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const sectorShift = header.getUint16(30, true);
  const sectorSize = 2 ** sectorShift;
  if ((sectorSize !== 512 && sectorSize !== 4096) || source.size < sectorSize) return "unknown-binary";
  const fatSectorCount = header.getUint32(44, true);
  const firstDirectorySector = header.getUint32(48, true);
  if (fatSectorCount > 128 || firstDirectorySector >= 0xfffffffa) return "unknown-binary";
  const fatSectorIds = [];
  for (let index = 0; index < 109 && fatSectorIds.length < fatSectorCount; index += 1) {
    const sector = header.getUint32(76 + index * 4, true);
    if (sector < 0xfffffffa) fatSectorIds.push(sector);
  }
  // Extended DIFAT files are intentionally not guessed in the stable table
  // playground. The document preview can perform the full bounded validation.
  if (fatSectorIds.length !== fatSectorCount) return "unknown-binary";
  const fat = [];
  for (const sector of fatSectorIds) {
    const bytes = await readSector(source, sector, sectorSize);
    if (bytes === undefined) return "unknown-binary";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length; offset += 4) fat.push(view.getUint32(offset, true));
  }
  let sector = firstDirectorySector;
  const visited = new Set();
  let word = false;
  let excel = false;
  while (sector < 0xfffffffa && visited.size < 4096) {
    if (visited.has(sector)) return "unknown-binary";
    visited.add(sector);
    const bytes = await readSector(source, sector, sectorSize);
    if (bytes === undefined) return "unknown-binary";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 128 <= bytes.length; offset += 128) {
      const nameBytes = Math.min(64, view.getUint16(offset + 64, true));
      if (nameBytes < 2 || nameBytes % 2 !== 0) continue;
      const name = new TextDecoder("utf-16le").decode(bytes.subarray(offset, offset + nameBytes - 2));
      if (name === "WordDocument") word = true;
      if (name === "Workbook" || name === "Book") excel = true;
    }
    if (word || excel) break;
    sector = fat[sector] ?? 0xffffffff;
  }
  if (word && !excel) return "doc";
  if (excel && !word) return "xls";
  return "unknown-binary";
}

async function readSector(source, sector, sectorSize) {
  if (!Number.isSafeInteger(sector)) return undefined;
  const start = (sector + 1) * sectorSize;
  const end = start + sectorSize;
  if (start < 0 || end > source.size) return undefined;
  return new Uint8Array(await source.slice(start, end).arrayBuffer());
}

function looksBinary(bytes) {
  if (bytes.length === 0) return false;
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
  }
  return controls / bytes.length > 0.02;
}

function isBlobLike(value) {
  return value !== null && typeof value === "object" && Number.isSafeInteger(value.size)
    && typeof value.slice === "function";
}

function bytesAt(bytes, expected) {
  return expected.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes, text) {
  return [...text].every((character, index) => bytes[index] === character.charCodeAt(0));
}

function u32(view, offset) {
  return offset >= 0 && offset + 4 <= view.byteLength ? view.getUint32(offset, true) : -1;
}

function safeBigUint(view, offset) {
  if (offset < 0 || offset + 8 > view.byteLength) return undefined;
  const value = view.getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}
