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
      if (url.pathname === "/health") {
        response.writeHead(200, {
          ...isolationHeaders,
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("ok");
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
          response.writeHead(204, isolationHeaders);
          response.end();
          return;
        }
        if (request.method === "GET") {
          const body = JSON.stringify(requestedScope === null
            ? requestLedger
            : requestLedger.filter(({ scope }) => scope === requestedScope));
          response.writeHead(200, {
            ...isolationHeaders,
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json; charset=utf-8",
          });
          response.end(body);
          return;
        }
        response.writeHead(405, { allow: "DELETE, GET" });
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
        respondNotFound(response);
        return;
      }

      let metadata = await stat(requestedPath).catch(() => undefined);
      if (metadata?.isDirectory()) {
        requestedPath = resolve(requestedPath, "index.html");
        metadata = await stat(requestedPath).catch(() => undefined);
      }
      if (metadata === undefined || !metadata.isFile()) {
        respondNotFound(response);
        return;
      }

      response.writeHead(200, {
        ...isolationHeaders,
        "cache-control": "no-store",
        "content-length": metadata.size,
        "content-type":
          contentTypes.get(extname(requestedPath)) ?? "application/octet-stream",
      });
      createReadStream(requestedPath).pipe(response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
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

function respondNotFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
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
