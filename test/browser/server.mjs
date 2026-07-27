#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultHost = process.env.TABULARK_TEST_HOST ?? "127.0.0.1";
const defaultPort = Number(process.env.TABULARK_TEST_PORT ?? 4173);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

function createTestServer({ crossOriginIsolated = false } = {}) {
  const requestLedger = [];
  const isolationHeaders = crossOriginIsolated
    ? {
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
      }
    : {};
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const responseHeaders = {
        ...isolationHeaders,
        ...corsHeaders(request),
      };
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...responseHeaders,
          "access-control-allow-headers":
            request.headers["access-control-request-headers"] ?? "Range",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }
      if (url.pathname === "/health") {
        response.writeHead(200, {
          ...responseHeaders,
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("ok");
        return;
      }
      if (url.pathname === "/__tabulark-test/redirect") {
        const target = url.searchParams.get("path");
        if (request.method !== "GET" || target === null || !/^\/test\//u.test(target)) {
          response.writeHead(400, {
            ...responseHeaders,
            "content-type": "text/plain; charset=utf-8",
          });
          response.end("invalid redirect target");
          return;
        }
        response.writeHead(302, {
          ...responseHeaders,
          "cache-control": "no-store",
          location: target,
        });
        response.end();
        return;
      }
      if (url.pathname === "/__tabulark-test/requests") {
        const requestedScope = url.searchParams.get("scope");
        if (request.method === "DELETE") {
          if (requestedScope === null) {
            requestLedger.length = 0;
          } else {
            for (let index = requestLedger.length - 1; index >= 0; index -= 1) {
              if (requestLedger[index].scope === requestedScope) requestLedger.splice(index, 1);
            }
          }
          response.writeHead(204, responseHeaders);
          response.end();
          return;
        }
        if (request.method === "GET") {
          const body = JSON.stringify(requestedScope === null
            ? requestLedger
            : requestLedger.filter(({ scope }) => scope === requestedScope));
          response.writeHead(200, {
            ...responseHeaders,
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json; charset=utf-8",
          });
          response.end(body);
          return;
        }
        response.writeHead(405, { ...responseHeaders, allow: "DELETE, GET" });
        response.end();
        return;
      }

      const scopeHeader = request.headers["x-tabulark-test-scope"];
      requestLedger.push(Object.freeze({
        method: request.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        range: request.headers.range ?? null,
        scope: typeof scopeHeader === "string" ? scopeHeader.slice(0, 128) : null,
      }));

      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      let requestedPath = resolve(
        repositoryRoot,
        relativePath || "index.html",
      );
      if (
        requestedPath !== repositoryRoot &&
        !requestedPath.startsWith(`${repositoryRoot}${sep}`)
      ) {
        respondNotFound(response, responseHeaders);
        return;
      }

      let metadata = await stat(requestedPath).catch(() => undefined);
      if (metadata?.isDirectory()) {
        requestedPath = resolve(requestedPath, "index.html");
        metadata = await stat(requestedPath).catch(() => undefined);
      }
      if (metadata === undefined || !metadata.isFile()) {
        respondNotFound(response, responseHeaders);
        return;
      }

      const entityHeaders = {
        ...responseHeaders,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-type":
          contentTypes.get(extname(requestedPath)) ?? "application/octet-stream",
        etag: strongEtag(metadata),
        "last-modified": metadata.mtime.toUTCString(),
      };
      const range = request.method === "GET"
        ? parseByteRange(request.headers.range, metadata.size)
        : undefined;
      if (range === null) {
        response.writeHead(416, {
          ...entityHeaders,
          "content-length": 0,
          "content-range": `bytes */${metadata.size}`,
        });
        response.end();
        return;
      }
      if (range !== undefined) {
        const contentLength = range.end - range.start + 1;
        response.writeHead(206, {
          ...entityHeaders,
          "content-length": contentLength,
          "content-range": `bytes ${range.start}-${range.end}/${metadata.size}`,
        });
        createReadStream(requestedPath, range).pipe(response);
        return;
      }

      response.writeHead(200, {
        ...entityHeaders,
        "content-length": metadata.size,
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        createReadStream(requestedPath).pipe(response);
      }
    } catch (error) {
      response.writeHead(500, {
        ...corsHeaders(request),
        "content-type": "text/plain; charset=utf-8",
      });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}

export async function startTestServer({
  crossOriginIsolated = false,
  host = defaultHost,
  port = defaultPort,
} = {}) {
  const server = createTestServer({ crossOriginIsolated });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export function stopTestServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  return {
    "access-control-allow-origin": typeof origin === "string" ? origin : "*",
    "access-control-expose-headers":
      "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
    vary: "Origin",
    ...(typeof origin === "string"
      ? { "access-control-allow-credentials": "true" }
      : {}),
  };
}

function parseByteRange(value, size) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const match = /^bytes=([0-9]*)-([0-9]*)$/u.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;

  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (size === 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function strongEtag(metadata) {
  return `"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`;
}

function respondNotFound(response, headers = {}) {
  response.writeHead(404, {
    ...headers,
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("not found");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startTestServer();
  console.log(`Tabulark test server listening on http://${defaultHost}:${defaultPort}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void stopTestServer(server).finally(() => process.exit(0));
    });
  }
}
