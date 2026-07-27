import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENT_PROTOCOL, DocumentPreviewError, createDocumentEngine } from "../dist/index.js";

test("a dedicated provider Worker opens, renders, caches copies, and closes idempotently", async () => {
  const workers = [];
  const provider = fakeProvider(workers);
  const engine = await createDocumentEngine({ providers: [provider], pageCacheBytes: 1024 * 1024 });
  provider.id = "mutated-after-registration";
  const session = await engine.open(new TextEncoder().encode("%PDF-test").buffer, { sourceName: "sample.pdf" });
  assert.equal(session.format, "pdf");
  assert.equal(session.pageCount, 2);
  assert.equal(session.capabilities.pagination, "source-pdf");
  assert.deepEqual(await session.getPageInfo(1), { pageIndex: 1, width: 612, height: 792, rotation: 0 });
  const first = await session.renderPage(0, { cssWidth: 100, devicePixelRatio: 1 });
  new Uint8Array(first.pixels)[0] = 99;
  const cached = await session.renderPage(0, { cssWidth: 100, devicePixelRatio: 1 });
  assert.equal(new Uint8Array(cached.pixels)[0], 7, "callers cannot mutate cached page pixels");
  assert.equal(workers[0].renderRequests, 1);
  await session.close();
  await session.close();
  assert.equal(workers[0].terminated, true);
  await engine.close();
});

test("resource limits and format sniffing fail before a Worker is created", async () => {
  const workers = [];
  const engine = await createDocumentEngine({ providers: [fakeProvider(workers)], maxInputBytes: 8 });
  await assert.rejects(engine.open(new Uint8Array(9).buffer), (error) => error instanceof DocumentPreviewError && error.code === "RESOURCE_LIMIT");
  await assert.rejects(engine.open(new TextEncoder().encode("not pdf").buffer), (error) => error instanceof DocumentPreviewError && error.code === "UNSUPPORTED_FORMAT");
  assert.equal(workers.length, 0);
  await engine.close();
});

test("render cancellation rejects promptly and stale pixels are ignored", async () => {
  const workers = [];
  const engine = await createDocumentEngine({ providers: [fakeProvider(workers, 40)] });
  const session = await engine.open(new TextEncoder().encode("%PDF-test").buffer);
  const controller = new AbortController();
  const rendering = session.renderPage(0, { cssWidth: 100, signal: controller.signal });
  controller.abort();
  await assert.rejects(rendering, (error) => error instanceof DocumentPreviewError && error.code === "CANCELLED");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await session.close();
  await engine.close();
});

test("engine registration validates duplicate formats and memory slices", async () => {
  const provider = fakeProvider([]);
  await assert.rejects(createDocumentEngine({ providers: [provider, provider] }), /one provider/);
  await assert.rejects(createDocumentEngine({
    providers: [provider], memoryBudgetBytes: 100, maxInputBytes: 60, pageCacheBytes: 60,
  }), /exceeds memoryBudgetBytes/);
});

function fakeProvider(workers, renderDelay = 0) {
  return {
    id: "test:pdf",
    format: "pdf",
    fidelity: "exact-source-pages",
    sniff: (head) => new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-",
    createWorker: () => {
      const worker = new FakeWorker(renderDelay);
      workers.push(worker);
      return worker;
    },
  };
}

class FakeWorker {
  messages = new Set();
  errors = new Set();
  terminated = false;
  renderRequests = 0;
  constructor(renderDelay) { this.renderDelay = renderDelay; }
  addEventListener(type, listener) { (type === "message" ? this.messages : this.errors).add(listener); }
  removeEventListener(type, listener) { (type === "message" ? this.messages : this.errors).delete(listener); }
  terminate() { this.terminated = true; }
  postMessage(request) {
    if (request.protocol !== DOCUMENT_PROTOCOL) return;
    const send = (result) => {
      const data = { protocol: DOCUMENT_PROTOCOL, kind: "response", requestId: request.requestId, generation: request.generation, ok: true, result };
      for (const listener of this.messages) listener({ data });
    };
    switch (request.operation) {
      case "hello": queueMicrotask(() => send({ operation: "hello", protocol: DOCUMENT_PROTOCOL })); break;
      case "open": queueMicrotask(() => send({ operation: "open", pageCount: 2, capabilities: { pagination: "source-pdf", localOnly: true, textSelection: false, search: false, print: false, exportImages: false } })); break;
      case "pageInfo": queueMicrotask(() => send({ operation: "pageInfo", page: { pageIndex: request.pageIndex, width: 612, height: 792, rotation: 0 } })); break;
      case "renderPage": {
        this.renderRequests += 1;
        const height = Math.round(request.pixelWidth * 792 / 612);
        const pixels = new Uint8Array(request.pixelWidth * height * 4).fill(7).buffer;
        setTimeout(() => send({ operation: "renderPage", page: { pageIndex: request.pageIndex, width: request.pixelWidth, height, stride: request.pixelWidth * 4, colorSpace: "srgb", pixels } }), this.renderDelay);
        break;
      }
      case "cancel": queueMicrotask(() => send({ operation: "cancel" })); break;
      case "close": queueMicrotask(() => send({ operation: "close" })); break;
      case "shutdown": queueMicrotask(() => send({ operation: "shutdown" })); break;
    }
  }
}
