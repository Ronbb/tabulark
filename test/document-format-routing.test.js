import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { detectLocalFormat } from "../examples/csv-preview/format-routing.js";

test("document signatures are routed away from table adapters", async () => {
  assert.equal(await detectLocalFormat(namedBlob(["%PDF-1.7\n"], "renamed.csv")), "pdf");
  assert.equal(await detectLocalFormat(namedBlob([makeZip(["word/document.xml"])], "renamed.xlsx")), "docx");
  assert.equal(await detectLocalFormat(namedBlob([makeZip(["xl/workbook.xml"])], "renamed.docx")), "xlsx");
  assert.equal(await detectLocalFormat(namedBlob([makeCfb("WordDocument")], "renamed.xls")), "doc");
});

test("CFB workbook streams remain on the Excel adapter", async () => {
  const fixture = await readFile(new URL("./fixtures/excel/v1/tabulark-biff8.xls", import.meta.url));
  assert.equal(await detectLocalFormat(namedBlob([fixture], "no-extension")), "xls");
});

test("unknown binaries never fall back to CSV while ordinary text still does", async () => {
  assert.equal(await detectLocalFormat(namedBlob([new Uint8Array([0, 1, 2, 3, 4])], "payload.bin")), "unknown-binary");
  assert.equal(await detectLocalFormat(namedBlob([new Uint8Array([0, 1, 2, 3, 4])], "misleading.csv")), "unknown-binary");
  assert.equal(await detectLocalFormat(namedBlob(["a,b\n1,2\n"], "no-extension")), "csv");
  assert.equal(await detectLocalFormat(namedBlob(["legacy"], "report.doc")), "doc");
});

function namedBlob(parts, name, type = "") {
  const blob = new Blob(parts, { type });
  Object.defineProperty(blob, "name", { value: name });
  return blob;
}

function makeZip(names) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const name of names) {
    const encoded = encoder.encode(name);
    const local = new Uint8Array(30 + encoded.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(26, encoded.length, true);
    local.set(encoded, 30);
    localParts.push(local);
    const central = new Uint8Array(46 + encoded.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(28, encoded.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(encoded, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, names.length, true);
  view.setUint16(10, names.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, localOffset, true);
  return new Blob([...localParts, ...centralParts, eocd]);
}

function makeCfb(streamName) {
  const bytes = new Uint8Array(1536);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, 0xfffffffe, true);
  view.setUint32(68, 0xfffffffe, true);
  for (let offset = 76; offset < 512; offset += 4) view.setUint32(offset, 0xffffffff, true);
  view.setUint32(76, 0, true);
  view.setUint32(512, 0xfffffffd, true);
  view.setUint32(516, 0xfffffffe, true);
  const encoded = new TextEncoder("utf-16le");
  // TextEncoder is UTF-8 only, so write the CFB UTF-16LE name explicitly.
  void encoded;
  const directoryOffset = 1024;
  for (let index = 0; index < streamName.length; index += 1) view.setUint16(directoryOffset + index * 2, streamName.charCodeAt(index), true);
  view.setUint16(directoryOffset + 64, streamName.length * 2 + 2, true);
  bytes[directoryOffset + 66] = 2;
  return bytes;
}
