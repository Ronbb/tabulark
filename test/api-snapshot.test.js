import assert from "node:assert/strict";
import test from "node:test";

import {
  collectStableDeclarationSnapshot,
  readCommittedStableDeclarationSnapshot,
} from "../scripts/stable-api-snapshot.mjs";

test("stable 0.1 entrypoints match the checked-in declaration graph snapshot", async () => {
  const [actual, expected] = await Promise.all([
    collectStableDeclarationSnapshot(),
    readCommittedStableDeclarationSnapshot(),
  ]);
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual.entrypoints), [".", "./arrow", "./parquet", "./excel"]);
  assert.ok(Object.keys(actual.files).length >= 8, "snapshot must include transitive declarations");
});
