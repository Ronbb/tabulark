import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADAPTER_API_VERSION,
  BATCH_LAYOUT_VERSION,
  PROTOCOL_VERSION,
} from "../dist/index.js";

const protocolRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "protocol",
);
const v1Directory = join(protocolRoot, "v1");
const v2Directory = join(protocolRoot, "v2");
const operations = new Set([
  "hello",
  "openSource",
  "listTables",
  "openTable",
  "getMetadata",
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
    assert.notEqual(payload.protocolVersion, PROTOCOL_VERSION, `${file} must be rejected by v2`);
  }
});

test("protocol v2 golden fixtures lock adapter registration and recursive schema envelopes", async () => {
  const files = (await readdir(v2Directory)).sort();
  assert.deepEqual(files, [
    "hello-request.json",
    "hello-response.json",
    "metadata-event.json",
    "open-arrow-request.json",
  ]);

  for (const file of files) {
    const payload = await fixture(v2Directory, file);
    assert.equal(payload.protocolVersion, PROTOCOL_VERSION, `${file} protocolVersion`);
    validateEnvelope(payload, file);
  }

  const helloRequest = await fixture(v2Directory, "hello-request.json");
  assert.deepEqual(helloRequest.payload.adapters.map(({ id }) => id), [
    "tabulark:delimited",
    "tabulark:arrow-ipc",
  ]);
  assert.equal(helloRequest.payload.memoryBudgetBytes, 256 * 1024 * 1024);

  const helloResponse = await fixture(v2Directory, "hello-response.json");
  assert.equal(helloResponse.result.data.adapterApiVersion, ADAPTER_API_VERSION);
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
