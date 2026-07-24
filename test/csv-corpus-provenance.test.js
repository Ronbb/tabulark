import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const corpusRoot = new URL("./fixtures/csv/v1/", import.meta.url);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function materializeText(bytes, source = {}) {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  if (source.lineEndings === "crlf") {
    text = text.replaceAll("\n", "\r\n");
  } else {
    assert.equal(source.lineEndings, undefined, "unsupported line-ending transform");
  }

  let materialized = Buffer.from(text, "utf8");
  if (source.stripFinalNewline) {
    if (materialized.subarray(-2).equals(Buffer.from("\r\n"))) {
      materialized = materialized.subarray(0, -2);
    } else if (
      materialized.subarray(-1).equals(Buffer.from("\n")) ||
      materialized.subarray(-1).equals(Buffer.from("\r"))
    ) {
      materialized = materialized.subarray(0, -1);
    } else {
      assert.fail("stripFinalNewline requires a final newline in the vendored text");
    }
  }

  if (source.encoding === "latin1") {
    const materializedText = new TextDecoder("utf-8", { fatal: true }).decode(materialized);
    materialized = Buffer.from(
      [...materializedText].map((character) => {
        const codePoint = character.codePointAt(0);
        assert.ok(codePoint <= 0xff, `${character} is outside Latin-1`);
        return codePoint;
      }),
    );
  } else {
    assert.equal(source.encoding, undefined, "unsupported encoding transform");
  }

  if (source.utf8Bom) {
    materialized = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), materialized]);
  }
  return materialized;
}

test("rust-csv fixtures retain pinned provenance and exact upstream bytes", async () => {
  const [manifest, provenance] = await Promise.all([
    readFile(new URL("manifest.json", corpusRoot), "utf8").then(JSON.parse),
    readFile(new URL("rust-csv-provenance.json", corpusRoot), "utf8").then(JSON.parse),
  ]);

  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.upstream.name, "BurntSushi/rust-csv");
  assert.equal(provenance.upstream.license, "MIT");
  assert.match(provenance.upstream.revision, /^[0-9a-f]{40}$/u);

  const localFiles = new Set();
  const upstreamPaths = new Set();
  const coveredCases = new Set();

  for (const file of provenance.files) {
    assert.ok(localFiles.add(file.localFile), `duplicate local file: ${file.localFile}`);
    assert.ok(
      upstreamPaths.add(file.upstreamPath),
      `duplicate upstream path: ${file.upstreamPath}`,
    );
    assert.equal(file.revision, provenance.upstream.revision);
    assert.ok(file.upstreamUrl.includes(file.revision), "upstream URL must pin the revision");
    assert.ok(file.upstreamUrl.endsWith(file.upstreamPath), "upstream URL must pin the path");
    assert.match(file.storedSha256, /^[0-9a-f]{64}$/u);
    assert.match(file.upstreamSha256, /^[0-9a-f]{64}$/u);

    const storedBytes = await readFile(new URL(file.localFile, corpusRoot));
    assert.equal(sha256(storedBytes), file.storedSha256, `${file.localFile} stored hash`);
    assert.equal(
      sha256(materializeText(storedBytes, file.materialization)),
      file.upstreamSha256,
      `${file.localFile} reconstructed upstream hash`,
    );

    if (file.kind === "license") {
      assert.deepEqual(file.caseIds, undefined);
      assert.equal(file.storedSha256, file.upstreamSha256, "license must be an exact copy");
      continue;
    }

    assert.equal(file.kind, "fixture");
    assert.ok(file.caseIds.length > 0, `${file.localFile} must be exercised by the corpus`);
    for (const caseId of file.caseIds) {
      assert.ok(coveredCases.add(caseId), `duplicate case provenance: ${caseId}`);
      const corpusCase = manifest.cases.find(({ id }) => id === caseId);
      assert.ok(corpusCase, `manifest is missing ${caseId}`);
      assert.equal(corpusCase.file, file.localFile);
      assert.equal(
        sha256(materializeText(storedBytes, corpusCase.source)),
        file.upstreamSha256,
        `${caseId} must parse the exact pinned upstream bytes`,
      );
    }
  }

  assert.equal(provenance.files.length, 4, "three fixtures and one license are pinned");
  assert.equal(coveredCases.size, 4, "strict and lenient capability cases are explicit");
  assert.ok(manifest.cases.every(({ id }) => !id.startsWith("csv-spectrum")));
});
