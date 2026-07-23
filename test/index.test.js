import assert from "node:assert/strict";
import test from "node:test";

import { PROJECT_STATUS, createTableShape } from "../js/index.js";

test("exports the prototype project status", () => {
  assert.equal(PROJECT_STATUS, "prototype");
});

test("creates immutable table shape metadata", () => {
  const shape = createTableShape(12, 4);

  assert.deepEqual(shape, { rows: 12, columns: 4 });
  assert.equal(Object.isFrozen(shape), true);
});

test("rejects invalid dimensions", () => {
  assert.throws(() => createTableShape(-1, 4), RangeError);
  assert.throws(() => createTableShape(1.5, 4), RangeError);
  assert.throws(() => createTableShape(Number.MAX_SAFE_INTEGER + 1, 4), RangeError);
});
