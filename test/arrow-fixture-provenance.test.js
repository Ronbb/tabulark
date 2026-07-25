import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureRoot = new URL("./fixtures/arrow/v1/", import.meta.url);

test("Arrow IPC fixtures retain pinned bytes, provenance, and licenses", async () => {
  const provenance = JSON.parse(await readFile(new URL("provenance.json", fixtureRoot), "utf8"));
  assert.equal(provenance.schemaVersion, 1);
  assert.match(provenance.external.revision, /^[0-9a-f]{40}$/u);
  assert.equal(provenance.external.license, "Apache-2.0");

  const license = await readFile(new URL(provenance.external.licenseFile, fixtureRoot));
  assert.equal(sha256(license), provenance.external.licenseSha256);

  for (const fixture of provenance.external.files) {
    const bytes = await readFile(new URL(fixture.path, fixtureRoot));
    assert.equal(bytes.byteLength, fixture.bytes, `${fixture.path} byte length`);
    assert.equal(sha256(bytes), fixture.sha256, `${fixture.path} digest`);
    assertArrowFile(bytes, fixture.path);
  }

  const sample = await readFile(new URL(provenance.playground.path, fixtureRoot));
  assert.equal(sample.byteLength, provenance.playground.bytes);
  assert.equal(sha256(sample), provenance.playground.sha256);
  assert.equal(provenance.playground.generator, "examples/generate_arrow_fixture.rs");
  assertArrowFile(sample, provenance.playground.path);
});

function assertArrowFile(bytes, name) {
  const magic = Buffer.from("ARROW1");
  assert.ok(bytes.subarray(0, magic.length).equals(magic), `${name} header magic`);
  assert.ok(bytes.subarray(-magic.length).equals(magic), `${name} footer magic`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
