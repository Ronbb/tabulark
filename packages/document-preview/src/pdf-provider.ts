import type { DocumentProviderDescriptor } from "./types.js";

export const pdfProvider: DocumentProviderDescriptor = Object.freeze({
  id: "tabulark:pdfium",
  format: "pdf",
  fidelity: "exact-source-pages",
  sniff(head: Uint8Array): boolean {
    return head.length >= 5
      && head[0] === 0x25
      && head[1] === 0x50
      && head[2] === 0x44
      && head[3] === 0x46
      && head[4] === 0x2d;
  },
  createWorker() {
    return new Worker(new URL("./pdf-worker.js", import.meta.url), {
      type: "module",
      name: "tabulark-pdf-preview",
    });
  },
});
