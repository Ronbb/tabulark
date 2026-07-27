import assert from "node:assert/strict";
import test from "node:test";

import {
  collectStableDeclarationSnapshot,
  readCommittedStableDeclarationSnapshot,
  readHistoricalV01DeclarationSnapshot,
} from "../scripts/stable-api-snapshot.mjs";

test("stable 0.2 entrypoints match the checked-in declaration graph snapshot", async () => {
  const [actual, expected, historical] = await Promise.all([
    collectStableDeclarationSnapshot(),
    readCommittedStableDeclarationSnapshot(),
    readHistoricalV01DeclarationSnapshot(),
  ]);
  assert.deepEqual(actual, expected);
  assert.equal(historical.compatibilityLine, "0.1.x");
  assert.deepEqual(Object.keys(historical.entrypoints), [".", "./arrow", "./parquet", "./excel"]);
  assert.equal(historical.files["dist/client.d.ts"].sha256, "32c145a9bca20331f6bd70607a875aab8f22751a9be93f479d57cab573087278");
  assert.deepEqual(Object.keys(actual.entrypoints), [".", "./arrow", "./parquet", "./excel", "./http"]);
  assert.ok(Object.keys(actual.files).length >= 8, "snapshot must include transitive declarations");
});
