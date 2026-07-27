import assert from "node:assert/strict";
import test from "node:test";

import { httpRangeSource } from "../dist/http.js";

const OPEN_LIMITS = Object.freeze({
  maxSourceBytes: 0xffff_ffff,
  maxStagingBytes: 1024,
});

function open(source, signal = new AbortController().signal) {
  return source.open({ signal, ...OPEN_LIMITS });
}

function response(bytes, {
  status = 206,
  contentRange,
  contentLength,
  etag = '"revision-1"',
  lastModified,
  retryAfter,
} = {}) {
  const headers = new Headers();
  if (contentRange !== undefined) headers.set("Content-Range", contentRange);
  if (contentLength !== undefined) headers.set("Content-Length", String(contentLength));
  if (etag !== undefined && etag !== null) headers.set("ETag", etag);
  if (lastModified !== undefined) headers.set("Last-Modified", lastModified);
  if (retryAfter !== undefined) headers.set("Retry-After", retryAfter);
  return new Response(Uint8Array.from(bytes), { status, headers });
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.name, "TabularkError");
    assert.equal(error?.code, code);
    return true;
  };
}

test("HTTP range readers require exact Content-Range and a stable validator", async (t) => {
  await t.test("accepts exact single ranges and keeps the snapshot opaque", async () => {
    const requestedRanges = [];
    const fetch = async (_url, init) => {
      requestedRanges.push(new Headers(init.headers).get("Range"));
      if (requestedRanges.length === 1) {
        return response([97], {
          contentRange: "bytes 0-0/6",
          contentLength: 1,
          etag: '"private-revision-value"',
        });
      }
      return response([99, 100, 101], {
        contentRange: "bytes 2-4/6",
        contentLength: 3,
        etag: '"private-revision-value"',
      });
    };

    const reader = await open(httpRangeSource("https://example.invalid/private.csv?token=secret", {
      fetch,
    }));
    assert.equal(reader.size, 6);
    assert.equal(reader.snapshot.strength, "strong");
    assert.match(reader.snapshot.id, /^http-[0-9a-f]{16}$/u);
    assert.equal(reader.snapshot.id.includes("private-revision-value"), false);
    assert.deepEqual(
      [...new Uint8Array(await reader.read(
        { offset: 2, length: 3 },
        { signal: new AbortController().signal },
      ))],
      [99, 100, 101],
    );
    assert.deepEqual(requestedRanges, ["bytes=0-0", "bytes=2-4"]);

    reader.close();
    reader.close();
    await assert.rejects(
      reader.read({ offset: 0, length: 1 }, { signal: new AbortController().signal }),
      assertCode("HANDLE_CLOSED"),
    );
  });

  for (const [name, contentRange] of [
    ["missing", undefined],
    ["wrong start", "bytes 1-1/6"],
    ["wrong length", "bytes 0-1/6"],
    ["wildcard total", "bytes 0-0/*"],
    ["malformed", "items 0-0/6"],
  ]) {
    await t.test(`rejects ${name} probe Content-Range`, async () => {
      const source = httpRangeSource("https://example.invalid/data", {
        maxAttempts: 1,
        fetch: async () => response([1], { contentRange }),
      });
      await assert.rejects(open(source), assertCode("RANGE_UNSUPPORTED"));
    });
  }

  await t.test("rejects a probe without ETag or Last-Modified", async () => {
    const source = httpRangeSource("https://example.invalid/data", {
      maxAttempts: 1,
      fetch: async () => response([1], {
        contentRange: "bytes 0-0/4",
        etag: null,
      }),
    });
    await assert.rejects(open(source), assertCode("SOURCE_UNAVAILABLE"));
  });

  await t.test("rejects non-HTTP Last-Modified strings accepted by Date.parse", async () => {
    const source = httpRangeSource("https://example.invalid/data", {
      maxAttempts: 1,
      fetch: async () => response([1], {
        contentRange: "bytes 0-0/4",
        etag: null,
        lastModified: "0",
      }),
    });
    await assert.rejects(open(source), assertCode("SOURCE_UNAVAILABLE"));
  });

  await t.test("uses Last-Modified plus length as a weak fallback and detects change", async () => {
    let calls = 0;
    const source = httpRangeSource("https://example.invalid/data", {
      fetch: async () => {
        calls += 1;
        return response(calls === 1 ? [1] : [2, 3], {
          contentRange: calls === 1 ? "bytes 0-0/4" : "bytes 1-2/4",
          etag: null,
          lastModified: calls === 1
            ? "Mon, 27 Jul 2026 00:00:00 GMT"
            : "Tue, 28 Jul 2026 00:00:00 GMT",
        });
      },
    });
    const reader = await open(source);
    assert.equal(reader.snapshot.strength, "weak");
    await assert.rejects(
      reader.read({ offset: 1, length: 2 }, { signal: new AbortController().signal }),
      assertCode("SOURCE_CHANGED"),
    );
    reader.close();
  });

  await t.test("accepts RFC opaque backslashes and rejects escape-style embedded quotes", async () => {
    const valid = httpRangeSource("https://example.invalid/data", {
      fetch: async () => response([1], {
        contentRange: "bytes 0-0/1",
        etag: '"ends-with-\\"',
      }),
    });
    const reader = await open(valid);
    assert.equal(reader.snapshot.strength, "strong");
    reader.close();

    const invalid = httpRangeSource("https://example.invalid/data", {
      maxAttempts: 1,
      fetch: async () => response([1], {
        contentRange: "bytes 0-0/1",
        etag: '"bad\\"quote"',
      }),
    });
    await assert.rejects(open(invalid), assertCode("SOURCE_UNAVAILABLE"));
  });
});

test("HTTP full-response fallback is explicit, bounded, and retained by its reader", async (t) => {
  const body = [10, 20, 30, 40, 50];
  const makeFetch = (counter) => async () => {
    counter.calls += 1;
    return response(body, {
      status: 200,
      contentLength: body.length,
      etag: '"fallback-revision"',
    });
  };

  await t.test("does not implicitly accept a 200 probe", async () => {
    const counter = { calls: 0 };
    const source = httpRangeSource("https://example.invalid/small.bin", {
      fetch: makeFetch(counter),
      maxAttempts: 1,
    });
    await assert.rejects(open(source), assertCode("RANGE_UNSUPPORTED"));
    assert.equal(counter.calls, 1);
  });

  await t.test("serves bounded slices without another fetch", async () => {
    const counter = { calls: 0 };
    const source = httpRangeSource("https://example.invalid/small.bin", {
      fetch: makeFetch(counter),
      fallback: { mode: "bounded-download", maxBytes: body.length },
    });
    const reader = await open(source);
    assert.equal(reader.size, body.length);
    assert.deepEqual(
      [...new Uint8Array(await reader.read(
        { offset: 1, length: 3 },
        { signal: new AbortController().signal },
      ))],
      [20, 30, 40],
    );
    assert.equal(counter.calls, 1);
    reader.close();
  });

  await t.test("requires trustworthy Content-Length and both configured bounds", async () => {
    const missingLength = httpRangeSource("https://example.invalid/small.bin", {
      fetch: async () => response(body, { status: 200, etag: '"fallback-revision"' }),
      fallback: { mode: "bounded-download", maxBytes: body.length },
      maxAttempts: 1,
    });
    await assert.rejects(open(missingLength), assertCode("RANGE_UNSUPPORTED"));

    const tooLarge = httpRangeSource("https://example.invalid/small.bin", {
      fetch: makeFetch({ calls: 0 }),
      fallback: { mode: "bounded-download", maxBytes: body.length - 1 },
      maxAttempts: 1,
    });
    await assert.rejects(open(tooLarge), (error) => {
      assert.equal(error.code, "RESOURCE_LIMIT");
      assert.deepEqual(error.details, {
        resource: "source-staging",
        requiredBytes: body.length,
        availableBytes: body.length - 1,
      });
      return true;
    });
  });
});

test("HTTP reads reject short and long bodies with structured byte counts", async (t) => {
  for (const [name, readBytes, actualBytes] of [
    ["short", [2, 3], 2],
    ["long", [2, 3, 4, 5], 4],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const source = httpRangeSource("https://example.invalid/data?credential=hidden", {
        fetch: async () => {
          calls += 1;
          if (calls === 1) {
            return response([1], { contentRange: "bytes 0-0/8", etag: '"secret-etag"' });
          }
          return response(readBytes, {
            contentRange: "bytes 2-4/8",
            etag: '"secret-etag"',
          });
        },
      });
      const reader = await open(source);
      await assert.rejects(
        reader.read({ offset: 2, length: 3 }, { signal: new AbortController().signal }),
        (error) => {
          assert.equal(error.code, "SOURCE_UNAVAILABLE");
          assert.deepEqual(error.details, { expectedBytes: 3, actualBytes });
          assert.equal(JSON.stringify(error).includes("credential=hidden"), false);
          assert.equal(JSON.stringify(error).includes("secret-etag"), false);
          return true;
        },
      );
      assert.equal(calls, 2, "short/long protocol bodies must not be retried");
      reader.close();
    });
  }
});

test("network failures while consuming a response body are retried", async () => {
  let calls = 0;
  const failingBody = (contentRange) => {
    const headers = new Headers({
      "Content-Range": contentRange,
      ETag: '"body-retry"',
    });
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("transient body transport failure"));
      },
    });
    return new Response(body, { status: 206, headers });
  };
  const source = httpRangeSource("https://example.invalid/body-retry", {
    maxAttempts: 3,
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async () => {
      calls += 1;
      if (calls === 1) return failingBody("bytes 0-0/4");
      if (calls === 2) return response([1], {
        contentRange: "bytes 0-0/4",
        etag: '"body-retry"',
      });
      if (calls === 3) return failingBody("bytes 1-2/4");
      return response([7, 8], {
        contentRange: "bytes 1-2/4",
        etag: '"body-retry"',
      });
    },
  });

  const reader = await open(source);
  assert.deepEqual(
    [...new Uint8Array(await reader.read(
      { offset: 1, length: 2 },
      { signal: new AbortController().signal },
    ))],
    [7, 8],
  );
  assert.equal(calls, 4);
  reader.close();
});

test("dynamic headers are refreshed for each retry and Range remains authoritative", async () => {
  const observed = [];
  let headerCalls = 0;
  let fetchCalls = 0;
  const source = httpRangeSource("https://example.invalid/authenticated", {
    credentials: "include",
    maxAttempts: 3,
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
    headers: async (context) => {
      headerCalls += 1;
      assert.equal(context.signal instanceof AbortSignal, true);
      return {
        Authorization: `Bearer token-${headerCalls}`,
        Range: "bytes=999-999",
        "X-Phase": context.phase,
      };
    },
    getHeaders: async ({ range }) => ({
      "X-Requested-Offset": String(range?.offset ?? "probe"),
    }),
    fetch: async (_url, init) => {
      fetchCalls += 1;
      const headers = new Headers(init.headers);
      observed.push({
        authorization: headers.get("Authorization"),
        range: headers.get("Range"),
        phase: headers.get("X-Phase"),
        requestedOffset: headers.get("X-Requested-Offset"),
        credentials: init.credentials,
      });
      if (fetchCalls === 1) {
        return response([], {
          status: 429,
          contentLength: 0,
          etag: '"retry-revision"',
          retryAfter: "0",
        });
      }
      if (fetchCalls === 3) throw new Error("transient network failure");
      if (fetchCalls === 2) {
        return response([1], {
          contentRange: "bytes 0-0/4",
          etag: '"retry-revision"',
        });
      }
      return response([7, 8], {
        contentRange: "bytes 1-2/4",
        etag: '"retry-revision"',
      });
    },
  });

  const reader = await open(source);
  assert.deepEqual(
    [...new Uint8Array(await reader.read(
      { offset: 1, length: 2 },
      { signal: new AbortController().signal },
    ))],
    [7, 8],
  );
  assert.equal(headerCalls, 4);
  assert.equal(fetchCalls, 4);
  assert.deepEqual(observed.map(({ authorization }) => authorization), [
    "Bearer token-1",
    "Bearer token-2",
    "Bearer token-3",
    "Bearer token-4",
  ]);
  assert.deepEqual(observed.map(({ range }) => range), [
    "bytes=0-0",
    "bytes=0-0",
    "bytes=1-2",
    "bytes=1-2",
  ]);
  assert.deepEqual(observed.map(({ phase }) => phase), ["probe", "probe", "read", "read"]);
  assert.deepEqual(observed.map(({ requestedOffset }) => requestedOffset), [
    "probe",
    "probe",
    "1",
    "1",
  ]);
  assert.ok(observed.every(({ credentials }) => credentials === "include"));
  reader.close();
});

test("only the documented HTTP status set is retried", async (t) => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const source = httpRangeSource("https://example.invalid/retry-status", {
        maxAttempts: 2,
        retry: { baseDelayMs: 0, maxDelayMs: 0 },
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? response([], { status, contentLength: 0, retryAfter: "0" })
            : response([1], { contentRange: "bytes 0-0/1", contentLength: 1 });
        },
      });
      const reader = await open(source);
      assert.equal(calls, 2);
      reader.close();
    });
  }

  await t.test("non-retryable status", async () => {
    let calls = 0;
    const source = httpRangeSource("https://example.invalid/no-retry", {
      maxAttempts: 3,
      retry: { baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        calls += 1;
        return response([], { status: 418, contentLength: 0 });
      },
    });
    await assert.rejects(open(source), (error) => {
      assert.equal(error?.code, "SOURCE_UNAVAILABLE");
      assert.equal(error?.retryable, false);
      assert.deepEqual(error?.details, { status: 418 });
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("HTTP readers snapshot mutable ranges before limiter and header awaits", async () => {
  let calls = 0;
  let notifyHeaderEntered;
  let releaseHeader;
  const headerEntered = new Promise((resolve) => { notifyHeaderEntered = resolve; });
  const headerGate = new Promise((resolve) => { releaseHeader = resolve; });
  const observed = [];
  const source = httpRangeSource("https://example.invalid/mutable", {
    headers: async (context) => {
      if (context.phase === "read") {
        assert.equal(Object.isFrozen(context), true);
        assert.equal(Object.isFrozen(context.range), true);
        notifyHeaderEntered();
        await headerGate;
      }
      return {};
    },
    fetch: async (_url, init) => {
      calls += 1;
      const range = new Headers(init.headers).get("Range");
      observed.push(range);
      return calls === 1
        ? response([1], { contentRange: "bytes 0-0/6" })
        : response([20, 30], { contentRange: "bytes 1-2/6" });
    },
  });

  const reader = await open(source);
  const mutable = { offset: 1, length: 2 };
  const reading = reader.read(mutable, { signal: new AbortController().signal });
  await headerEntered;
  mutable.offset = 4;
  mutable.length = 4096;
  releaseHeader();

  assert.deepEqual([...new Uint8Array(await reading)], [20, 30]);
  assert.deepEqual(observed, ["bytes=0-0", "bytes=1-2"]);
  reader.close();
});

test("reader close aborts an in-flight fetch and source errors do not leak request secrets", async (t) => {
  await t.test("close is idempotent and aborts an active read", async () => {
    let calls = 0;
    let readSignal;
    let notifyReadStarted;
    const readStarted = new Promise((resolve) => { notifyReadStarted = resolve; });
    const source = httpRangeSource("https://example.invalid/data", {
      fetch: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          return response([1], { contentRange: "bytes 0-0/4" });
        }
        readSignal = init.signal;
        notifyReadStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    });
    const reader = await open(source);
    const reading = reader.read(
      { offset: 1, length: 2 },
      { signal: new AbortController().signal },
    );
    await readStarted;
    reader.close();
    reader.close();
    assert.equal(readSignal.aborted, true);
    await assert.rejects(reading, assertCode("HANDLE_CLOSED"));
  });

  await t.test("transport diagnostics never retain URL, headers, or validators", async () => {
    const secrets = [
      "private-token-17",
      "Authorization: Bearer classified",
      '"private-etag-99"',
    ];
    const source = httpRangeSource(
      `https://private.invalid/table.csv?token=${secrets[0]}`,
      {
        maxAttempts: 1,
        headers: { Authorization: "Bearer classified" },
        fetch: async () => {
          throw new Error(`${secrets[1]} at https://private.invalid; ETag=${secrets[2]}`);
        },
      },
    );
    await assert.rejects(open(source), (error) => {
      assert.equal(error.code, "SOURCE_UNAVAILABLE");
      assert.equal(error.retryable, true);
      assert.equal(error.cause, undefined);
      const publicShape = `${error.name}\n${error.message}\n${JSON.stringify(error.details)}\n${JSON.stringify(error)}`;
      for (const secret of secrets) assert.equal(publicShape.includes(secret), false);
      assert.equal(publicShape.includes("private.invalid"), false);
      return true;
    });
  });
});
