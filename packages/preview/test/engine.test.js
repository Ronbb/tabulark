import assert from "node:assert/strict";
import test from "node:test";
import { PreviewError, createPreviewEngine, structuredProvider } from "../dist/index.js";

test("routes JSON by signature and keeps structured data as a tree until projection is explicit", async () => {
  const engine = createPreviewEngine();
  const session = await engine.open(new Blob(['[{"name":"one","n":1},{"name":"two","n":2}]']), { sourceName: "misleading.csv" });
  assert.equal(session.kind, "structured"); assert.equal(session.format, "json");
  assert.deepEqual(session.getChildren(0).map((node) => node.type), ["object", "object"]);
  assert.deepEqual(session.projectArray(0).columns, ["name", "n"]);
  await session.close(); await engine.close();
});
test("text detects UTF-16 BOM, preserves line numbers, and bounds search", async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00, 0x62, 0x00]); const engine = createPreviewEngine({ limits: { maxSearchResults: 2 } }); const session = await engine.open(bytes.buffer, { sourceName: "notes.txt" });
  assert.equal(session.kind, "text"); assert.equal(session.metadata.encoding, "utf-16le"); assert.deepEqual(session.getLines(0, 2).map((line) => line.text), ["a", "b"]); assert.equal(session.search("a").length, 1); await engine.close();
});
test("range sources detect short reads and are closed on a rejected preview", async () => {
  let closed = 0; const source = { kind: "range", name: "bad.json", async open() { return { size: 2, snapshot: { id: "v1", strength: "strong" }, async read() { return new Uint8Array(1); }, async close() { closed += 1; } }; } }; const engine = createPreviewEngine();
  await assert.rejects(engine.open(source), (error) => error instanceof PreviewError && error.code === "SOURCE_CHANGED"); assert.equal(closed, 1); await engine.close();
});
test("providers are a closed bundled manifest and limits are explicit", async () => {
  assert.throws(() => createPreviewEngine({ providers: [{ id: "url:https://evil", formats: ["json"], kinds: ["structured"] }] }), /officialPreviewProviders/);
  const engine = createPreviewEngine({ providers: [structuredProvider], limits: { maxTextBytes: 3 } }); await assert.rejects(engine.open(new Blob(["{}\n\n"])), (error) => error instanceof PreviewError && error.code === "RESOURCE_LIMIT"); await engine.close();
});
