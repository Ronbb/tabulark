import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "protocol",
  "v1",
);

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

test("protocol v1 golden fixtures have valid, versioned envelopes", async () => {
  const files = (await readdir(fixtureDirectory)).sort();
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
    const payload = JSON.parse(await readFile(join(fixtureDirectory, file), "utf8"));
    assert.equal(payload.protocolVersion, 1, `${file} protocolVersion`);

    if ("op" in payload) {
      assert.equal(typeof payload.requestId, "string", `${file} requestId`);
      assert.ok(operations.has(payload.op), `${file} operation`);
      assert.ok("payload" in payload, `${file} payload`);
      continue;
    }

    if ("event" in payload) {
      assert.ok(events.has(payload.event), `${file} event`);
      if (payload.event !== "runtimeError") {
        assert.equal(typeof payload.datasetHandle, "string", `${file} datasetHandle`);
      }
      if ("tableHandle" in payload) {
        assert.equal(typeof payload.datasetHandle, "string", `${file} table routing`);
      }
      assert.ok("payload" in payload, `${file} payload`);
      continue;
    }

    assert.equal(typeof payload.requestId, "string", `${file} requestId`);
    if (payload.status === "success") {
      assert.equal(typeof payload.result?.kind, "string", `${file} result kind`);
      continue;
    }

    assert.equal(payload.status, "failure", `${file} failure marker`);
    assert.equal(typeof payload.error?.code, "string", `${file} error code`);
    assert.equal(typeof payload.error?.message, "string", `${file} error message`);
    assert.equal(typeof payload.error?.retryable, "boolean", `${file} retryable`);
  }
});

test("protocol v1 fixtures lock the handshake, acknowledgement, and error shapes", async () => {
  const helloRequest = await fixture("hello-request.json");
  assert.deepEqual(helloRequest, {
    protocolVersion: 1,
    requestId: "request-hello-001",
    op: "hello",
    payload: { clientName: "tabulark-js" },
  });

  const acknowledgement = await fixture("close-response.json");
  assert.deepEqual(acknowledgement.result, { kind: "acknowledged" });

  const failure = await fixture("invalid-range-response.json");
  assert.equal(failure.status, "failure");
  assert.equal(failure.error.code, "INVALID_RANGE");
  assert.equal(failure.error.retryable, false);

  const warning = await fixture("warning-event.json");
  assert.equal(warning.datasetHandle, "d1");
  assert.equal(warning.tableId, "csv:table:0");
  assert.deepEqual(warning.payload, {
    handle: "d1",
    kind: "ragged-row",
    message: "row has 1 fields but the schema has 2",
    byteOffset: 12,
    row: 3,
  });
});

async function fixture(file) {
  return JSON.parse(await readFile(join(fixtureDirectory, file), "utf8"));
}
