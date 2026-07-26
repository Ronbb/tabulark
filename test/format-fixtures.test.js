import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

for (const format of ["parquet", "excel"]) {
  test(`${format} browser fixtures retain pinned bytes and provenance`, async () => {
    const versionRoot = join(fixtureRoot, format, "v1");
    const provenance = JSON.parse(await readFile(join(versionRoot, "provenance.json"), "utf8"));
    assert.equal(provenance.schemaVersion, 1);
    assert.ok(typeof provenance.producer === "string" && provenance.producer.length > 0);
    assert.ok(Array.isArray(provenance.files) && provenance.files.length >= 2);
    assert.ok(
      new Set(provenance.files.map(({ producer }) => producer).filter(Boolean)).size >= 2,
      `${format} fixtures must cover two independent producers`,
    );
    for (const fixture of provenance.files) {
      const bytes = await readFile(join(versionRoot, fixture.path));
      assert.equal(bytes.byteLength, fixture.bytes, fixture.path);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256, fixture.path);
      if (fixture.upstream !== undefined) {
        assert.match(fixture.upstream.revision, /^[0-9a-f]{40}$/u, fixture.path);
        assert.match(fixture.upstream.blob, /^[0-9a-f]{40}$/u, fixture.path);
        assert.match(fixture.upstream.repository, /^https:\/\/github\.com\//u, fixture.path);
        const license = await readFile(join(versionRoot, fixture.upstream.licenseFile), "utf8");
        assert.ok(license.length > 500, `${fixture.path} upstream license`);
      }
    }
  });
}

test("fuzz corpus copies match their pinned format fixtures", async () => {
  const copiedFixtures = [
    [
      "parquet_lifecycle/apache-alltypes-plain.parquet",
      "parquet/v1/apache-parquet-testing-alltypes-plain.parquet",
    ],
    ["parquet_lifecycle/tabulark-rust.parquet", "parquet/v1/tabulark-rust.parquet"],
    ["excel_lifecycle/tabulark-biff8.xls", "excel/v1/tabulark-biff8.xls"],
    ["excel_lifecycle/tabulark-ooxml.xlsx", "excel/v1/tabulark-ooxml.xlsx"],
    [
      "excel_lifecycle/xlsxwriter-merge-range01.xlsx",
      "excel/v1/xlsxwriter-merge-range01.xlsx",
    ],
  ];

  for (const [seed, fixture] of copiedFixtures) {
    const [seedBytes, fixtureBytes] = await Promise.all([
      readFile(join(repositoryRoot, "fuzz", "corpus", seed)),
      readFile(join(fixtureRoot, fixture)),
    ]);
    assert.deepEqual(seedBytes, fixtureBytes, `${seed} must match ${fixture}`);
  }
});
