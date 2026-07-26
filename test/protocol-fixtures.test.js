import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Worker protocol and adapter ABI are intentionally private; the golden tests
// pin them without creating a package export for their implementation module.
const PROTOCOL_VERSION = 4;
const ADAPTER_API_VERSION = 3;
const BATCH_LAYOUT_VERSION = 1;

const protocolRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "protocol",
);
const v1Directory = join(protocolRoot, "v1");
const v2Directory = join(protocolRoot, "v2");
const v3Directory = join(protocolRoot, "v3");
const v4Directory = join(protocolRoot, "v4");
const operations = new Set([
  "hello",
  "openSource",
  "listTables",
  "openTable",
  "getMetadata",
  "getPresentation",
  "readPresentationRange",
  "readRange",
  "cancel",
  "closeTable",
  "closeSource",
  "shutdown",
]);
const events = new Set(["progress", "metadata", "warning", "closed", "runtimeError"]);

test("protocol v1 fixtures remain immutable historical evidence", async () => {
  const files = (await readdir(v1Directory)).sort();
  assert.deepEqual(files, [
    "close-response.json",
    "hello-request.json",
    "hello-response.json",
    "invalid-range-response.json",
    "metadata-event.json",
    "open-source-request.json",
    "read-range-request.json",
    "warning-event.json",
  ]);
  for (const file of files) {
    const payload = await fixture(v1Directory, file);
    assert.equal(payload.protocolVersion, 1, `${file} remains v1`);
    assert.notEqual(payload.protocolVersion, PROTOCOL_VERSION, `${file} must be rejected by v4`);
  }
});

test("protocol v2 fixtures remain immutable M4 evidence", async () => {
  const files = (await readdir(v2Directory)).sort();
  assert.deepEqual(files, [
    "hello-request.json",
    "hello-response.json",
    "metadata-event.json",
    "open-arrow-request.json",
  ]);

  for (const file of files) {
    const payload = await fixture(v2Directory, file);
    assert.equal(payload.protocolVersion, 2, `${file} protocolVersion`);
    assert.notEqual(payload.protocolVersion, PROTOCOL_VERSION, `${file} must be rejected by v4`);
    validateEnvelope(payload, file);
  }

  const helloRequest = await fixture(v2Directory, "hello-request.json");
  assert.deepEqual(helloRequest.payload.adapters.map(({ id }) => id), [
    "tabulark:delimited",
    "tabulark:arrow-ipc",
  ]);
  assert.equal(helloRequest.payload.memoryBudgetBytes, 256 * 1024 * 1024);

  const helloResponse = await fixture(v2Directory, "hello-response.json");
  assert.equal(helloResponse.result.data.adapterApiVersion, 1);
  assert.equal(helloResponse.result.data.batchLayoutVersion, BATCH_LAYOUT_VERSION);

  const openArrow = await fixture(v2Directory, "open-arrow-request.json");
  assert.equal(openArrow.payload.adapterId, "tabulark:arrow-ipc");
  assert.deepEqual(openArrow.payload.options, {
    container: "auto",
    sourceName: "m4-sample.arrow",
  });

  const metadata = await fixture(v2Directory, "metadata-event.json");
  assert.deepEqual(metadata.payload.schema.columns[1].dataType, {
    type: "list",
    field: {
      name: "item",
      dataType: { type: "utf8" },
      nullable: true,
    },
  });
});

test("protocol v3 fixtures remain immutable presentation-era evidence", async () => {
  const files = (await readdir(v3Directory)).sort();
  assert.deepEqual(files, [
    "hello-request.json",
    "hello-response.json",
    "metadata-event.json",
    "presentation-range-request.json",
    "presentation-range-response.json",
    "presentation-response.json",
    "progress-event.json",
  ]);

  for (const file of files) {
    const payload = await fixture(v3Directory, file);
    assert.equal(payload.protocolVersion, 3, `${file} protocolVersion`);
    assert.notEqual(payload.protocolVersion, PROTOCOL_VERSION, `${file} must be rejected by v4`);
    validateEnvelope(payload, file);
  }

  const helloRequest = await fixture(v3Directory, "hello-request.json");
  assert.deepEqual(helloRequest.payload.adapters.map(({ id }) => id), [
    "tabulark:delimited",
    "tabulark:arrow-ipc",
    "tabulark:parquet",
    "tabulark:excel",
  ]);
  assert.equal(
    helloRequest.payload.adapters.some((adapter) => "moduleUrl" in adapter),
    false,
    "v3 hello carries only manifest IDs",
  );

  const helloResponse = await fixture(v3Directory, "hello-response.json");
  assert.equal(helloResponse.result.data.adapterApiVersion, 2);
  assert.equal(helloResponse.result.data.batchLayoutVersion, BATCH_LAYOUT_VERSION);

  const rangeRequest = await fixture(v3Directory, "presentation-range-request.json");
  assert.equal(rangeRequest.op, "readPresentationRange");
  assert.deepEqual(rangeRequest.payload.range, {
    rowStart: 4,
    rowCount: 2,
    columnStart: 1,
    columnCount: 3,
  });

  const presentation = await fixture(v3Directory, "presentation-response.json");
  assert.equal(presentation.result.kind, "presentation");
  assert.equal(presentation.result.data.kind, "spreadsheet-v1");
  assert.equal(presentation.result.data.visibility, "hidden");

  const metadata = await fixture(v3Directory, "metadata-event.json");
  assert.equal(metadata.revision, 7);
  assert.equal(metadata.payload.revision, metadata.revision);
  assert.equal(metadata.tableId, metadata.payload.tableId);

  const progress = await fixture(v3Directory, "progress-event.json");
  assert.equal(progress.revision, 3);
  assert.equal(progress.payload.revision, progress.revision);
  assert.equal(progress.tableId, progress.payload.tableId);
  assert.equal(progress.payload.done, false);

  const presentationRange = await fixture(v3Directory, "presentation-range-response.json");
  assert.equal(presentationRange.result.kind, "presentationRange");
  assert.equal(presentationRange.result.data.revision, 7);
  assert.deepEqual(presentationRange.result.data.range, rangeRequest.payload.range);
  assert.equal(presentationRange.result.data.styleIds.length, rangeRequest.payload.range.rowCount);
  assert.equal(presentationRange.result.data.styleIds[0].length, rangeRequest.payload.range.columnCount);
  assert.deepEqual(presentationRange.result.data.mergedCells, [
    { rowStart: 4, rowCount: 2, columnStart: 1, columnCount: 2 },
  ]);
});

test("protocol v4 and adapter ABI v3 fixtures lock revisions, batches, and yields", async () => {
  const files = (await readdir(v4Directory)).sort();
  assert.deepEqual(files, [
    "adapter-complete-step.json",
    "adapter-pending-step.json",
    "adapter-progress-step.json",
    "hello-request.json",
    "hello-response.json",
  ]);

  for (const file of ["hello-request.json", "hello-response.json"]) {
    const payload = await fixture(v4Directory, file);
    assert.equal(payload.protocolVersion, PROTOCOL_VERSION, `${file} protocolVersion`);
    validateEnvelope(payload, file);
  }
  const helloResponse = await fixture(v4Directory, "hello-response.json");
  assert.equal(helloResponse.result.data.adapterApiVersion, ADAPTER_API_VERSION);
  assert.equal(helloResponse.result.data.batchLayoutVersion, BATCH_LAYOUT_VERSION);

  const pending = await fixture(v4Directory, "adapter-pending-step.json");
  assert.equal(pending.kind, "pending");
  assert.equal(pending.operationRevision, 1);
  assert.equal(pending.actions.length, 2);
  assert.deepEqual(pending.actions.map(({ actionIndex }) => actionIndex), [0, 1]);
  assert.ok(pending.actions.every(({ offset, length }) => Number.isSafeInteger(offset + length)));

  const progress = await fixture(v4Directory, "adapter-progress-step.json");
  assert.equal(progress.kind, "progress");
  assert.equal(progress.operationRevision, 2);
  assert.equal(progress.cooperativeYield, true);
  assert.deepEqual(progress.actions, []);

  const complete = await fixture(v4Directory, "adapter-complete-step.json");
  assert.equal(complete.kind, "complete");
  assert.equal(complete.operationRevision, 3);
  assert.deepEqual(complete.actions, []);
});

function validateEnvelope(payload, file) {
  if ("op" in payload) {
    assert.equal(typeof payload.requestId, "string", `${file} requestId`);
    assert.ok(operations.has(payload.op), `${file} operation`);
    assert.ok("payload" in payload, `${file} payload`);
    return;
  }
  if ("event" in payload) {
    assert.ok(events.has(payload.event), `${file} event`);
    if (payload.event !== "runtimeError") {
      assert.equal(typeof payload.datasetHandle, "string", `${file} datasetHandle`);
    }
    assert.ok("payload" in payload, `${file} payload`);
    return;
  }
  assert.equal(typeof payload.requestId, "string", `${file} requestId`);
  if (payload.status === "success") {
    assert.equal(typeof payload.result?.kind, "string", `${file} result kind`);
    return;
  }
  assert.equal(payload.status, "failure", `${file} failure marker`);
  assert.equal(typeof payload.error?.code, "string", `${file} error code`);
}

async function fixture(directory, file) {
  return JSON.parse(await readFile(join(directory, file), "utf8"));
}
