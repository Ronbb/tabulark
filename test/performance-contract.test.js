import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { startTestServer, stopTestServer } from "./browser/server.mjs";

test("performance scenarios and size budgets remain reproducible and bounded", async () => {
  const [manifest, budget] = await Promise.all([
    readJson("./performance/scenarios.json"),
    readJson("./performance/size-budget.json"),
  ]);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(budget.schemaVersion, 1);
  for (const [name, scenario] of Object.entries(manifest.scenarios)) {
    assert.ok(Number.isSafeInteger(scenario.requestedBytes) && scenario.requestedBytes > 0, name);
    assert.ok(scenario.generatedBytes >= scenario.requestedBytes, name);
    assert.ok(Number.isSafeInteger(scenario.rows) && scenario.rows > 0, name);
    assert.match(scenario.sha256, /^[0-9a-f]{64}$/u, name);
    assert.ok(Number.isSafeInteger(scenario.scrollFrames) && scenario.scrollFrames >= 60, name);
  }
  assert.ok(manifest.scenarios.canonical.requestedBytes > 8 * 1024 * 1024);
  assert.ok(manifest.scenarios.canonical.measuredIterations >= 5);
  assert.ok(manifest.scenarios.canonical.warmupIterations >= 1);

  assert.deepEqual(Object.keys(budget.maximumBytes).sort(), [
    "npmPacked",
    "npmUnpacked",
    "pagesBrotli",
    "pagesRaw",
    "runtimeBrotli",
    "runtimeRaw",
  ]);
  for (const maximum of Object.values(budget.maximumBytes)) {
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0);
  }
});

test("performance server opts into cross-origin isolation explicitly", async () => {
  const server = await startTestServer({ crossOriginIsolated: true, port: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/test/performance/harness.html`,
      { headers: { connection: "close" } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  } finally {
    await stopTestServer(server);
  }
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}
