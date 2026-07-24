import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  MAX_ARRAY_BUFFER_BYTES,
  MAX_RANGE_CELLS,
  PROJECT_STATUS,
  PROTOCOL_VERSION,
  createEngine,
  createTableShape,
} from "../dist/index.js";

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

test("exports the experimental M1 limits and protocol version", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(DEFAULT_MEMORY_BUDGET_BYTES, 256 * 1024 * 1024);
  assert.equal(MAX_ARRAY_BUFFER_BYTES, 128 * 1024 * 1024);
  assert.equal(MAX_RANGE_CELLS, 250_000);
});

test("rejects engine creation outside a browser", async () => {
  await assert.rejects(createEngine(), (error) => {
    assert.equal(error.code, "UNSUPPORTED_RUNTIME");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("validates the engine memory budget before runtime startup", async () => {
  await assert.rejects(createEngine({ memoryBudgetBytes: 0 }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    return true;
  });
});
