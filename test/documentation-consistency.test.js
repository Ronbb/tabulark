import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const documents = [
  "README.md",
  "docs/architecture.md",
  "docs/mvp.md",
  "docs/testing.md",
  "docs/releasing.md",
  "docs/vision.md",
];

test("release-facing documentation describes the finalized 0.2.1 candidate consistently", async () => {
  const sources = await Promise.all(documents.map(async (path) => [
    path,
    await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
  ]));
  for (const [path, source] of sources) {
    assert.match(source, /0\.2\.1/u, `${path} does not identify the current release`);
    assert.doesNotMatch(
      source,
      /(?:current|the)\s+(?:tree|release)\s+is[^\n]*(?:candidate|unpublished)/iu,
      `${path} still describes the current release as unpublished`,
    );
    assert.doesNotMatch(
      source,
      /No release tag has been created|0\.1\.0 has not been published/iu,
      `${path} contains an obsolete release-status claim`,
    );
    assert.doesNotMatch(
      source,
      /(?:current status|current tree|this document describes)[^\n]*0\.1\.1/iu,
      `${path} still describes 0.1.1 as current`,
    );
  }
  const evidence = await readFile(
    new URL("../docs/release-0.1.0-evidence.md", import.meta.url),
    "utf8",
  );
  assert.match(evidence, /`v0\.1\.0`/u);
  assert.match(evidence, /f10e40b0c51627676cbcaa87a07d14219db31eb2/u);
  assert.match(evidence, /30188979881/u);
  assert.match(evidence, /never republishes/u);
});

test("the 0.2.1 version fields and changelog heading stay synchronized", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const cargo = await readFile(new URL("../Cargo.toml", import.meta.url), "utf8");
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.equal(packageJson.version, "0.2.1");
  assert.match(cargo, /^version\s*=\s*"0\.2\.1"$/mu);
  assert.match(changelog, /^## 0\.2\.1$/mu);
  assert.doesNotMatch(changelog, /^## 0\.1\.1$/mu);
});
