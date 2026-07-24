import { createCanvasTableView, createEngine } from "../../dist/index.js";

const NativeWorker = globalThis.Worker;
let workerMetrics = freshWorkerMetrics();
let pendingFirstDataPaint = null;

class MeasuringWorker extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    this.addEventListener("message", (event) => recordWorkerMessage(event.data));
  }
}

globalThis.Worker = MeasuringWorker;

const nativeFillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
  const result = nativeFillText.call(this, text, ...args);
  if (
    pendingFirstDataPaint !== null
    && this.canvas?.matches?.("[data-tabulark-canvas]")
    && text === "name-1"
  ) {
    const resolve = pendingFirstDataPaint;
    pendingFirstDataPaint = null;
    requestAnimationFrame((timestamp) => resolve(timestamp));
  }
  return result;
};

globalThis.__tabularkRunPerformanceScenario = runScenario;
globalThis.__tabularkPerformanceReady = true;

async function runScenario({ expectedRows, requireMemory = true, scrollFrames = 120 } = {}) {
  const input = document.querySelector("#source");
  const host = document.querySelector("#host");
  const source = input?.files?.[0];
  if (!(source instanceof File) || !(host instanceof HTMLElement)) {
    throw new Error("performance harness requires a File input and host element");
  }
  if (!crossOriginIsolated) {
    throw new Error("performance harness must run with COOP/COEP isolation");
  }
  const memoryAvailable = typeof performance.measureUserAgentSpecificMemory === "function";
  const forcedGcAvailable = typeof globalThis.gc === "function";
  if (requireMemory && !memoryAvailable) {
    throw new Error("measureUserAgentSpecificMemory is unavailable in canonical Chromium");
  }
  if (requireMemory && !forcedGcAvailable) {
    throw new Error("forced garbage collection is unavailable in canonical Chromium");
  }

  host.replaceChildren();
  workerMetrics = freshWorkerMetrics();
  const memory = [];
  const measureMemory = async (phase) => {
    if (!memoryAvailable) return;
    if (forcedGcAvailable) globalThis.gc();
    const measurement = await performance.measureUserAgentSpecificMemory();
    if (!Number.isFinite(measurement.bytes) || measurement.bytes <= 0) {
      throw new Error(`invalid memory measurement for ${phase}`);
    }
    memory.push({ phase, bytes: measurement.bytes });
  };

  let engine;
  let dataset;
  let table;
  let view;
  try {
    await measureMemory("idle");
    const startupStart = performance.now();
    engine = await createEngine({ memoryBudgetBytes: 128 * 1024 * 1024 });
    const workerWasmStartupMs = performance.now() - startupStart;
    await measureMemory("engine-ready");

    const openStart = performance.now();
    dataset = await engine.open(source, {
      format: "csv",
      header: "first-row",
      mode: "strict",
      sourceName: source.name,
    });
    table = await dataset.openTable(dataset.tables[0].id);

    const firstPaint = new Promise((resolve) => {
      pendingFirstDataPaint = resolve;
    });
    view = createCanvasTableView({
      container: host,
      table,
      maxDevicePixelRatio: 1,
      controllerOptions: { overscanColumns: 0, overscanRows: 4 },
    });

    const [firstPaintTimestamp, completedScan] = await Promise.all([
      withTimeout(firstPaint, 30_000, "first usable Canvas paint"),
      waitForCompletedScan(60_000),
    ]);
    const firstUsablePaintMs = firstPaintTimestamp - openStart;
    const completedScanMs = completedScan.timestamp - openStart;
    await measureMemory("scan-complete");

    const rowCount = Number.isSafeInteger(expectedRows)
      ? expectedRows
      : table.metadata.extent.rows.kind === "exact"
        ? table.metadata.extent.rows.value
        : completedScan.rowsDiscovered;
    const columnCount = table.metadata.schema.columns.length;
    const starts = [0.25, 0.5, 0.75].map((ratio) => Math.max(
      0,
      Math.min(rowCount - 1, Math.floor(rowCount * ratio)),
    ));
    const rangeReadMs = [];
    const rangeBatchBytes = [];
    for (const rowStart of starts) {
      const started = performance.now();
      const batch = await table.readRange({
        rowStart,
        rowCount: Math.min(128, Math.max(0, rowCount - rowStart)),
        columnStart: 0,
        columnCount,
      });
      rangeReadMs.push(performance.now() - started);
      rangeBatchBytes.push(batch.byteLength);
    }

    const scroller = view.element.querySelector("[data-tabulark-scroll]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Canvas view did not expose its scroll host");
    }
    const frameDeltas = await measureScrollFrames(scroller, scrollFrames);
    await nextAnimationFrame();
    await measureMemory("scroll-complete");

    view.destroy();
    view = undefined;
    await table.close();
    table = undefined;
    await dataset.close();
    dataset = undefined;
    await engine.close();
    engine = undefined;
    await nextAnimationFrame();
    await measureMemory("closed");

    const idleBytes = memory[0]?.bytes;
    const peakBytes = memory.length === 0 ? undefined : Math.max(...memory.map(({ bytes }) => bytes));
    const memoryPeakDeltaBytes = idleBytes === undefined || peakBytes === undefined
      ? undefined
      : Math.max(0, peakBytes - idleBytes);
    return {
      workerWasmStartupMs,
      firstUsablePaintMs,
      completedScan: {
        durationMs: completedScanMs,
        bytesScanned: completedScan.bytesScanned,
        rowsDiscovered: completedScan.rowsDiscovered,
        mibPerSecond: source.size / (1024 * 1024) / (completedScanMs / 1000),
      },
      rangeRead: summarize(rangeReadMs, { samples: rangeReadMs }),
      rangeBatchBytes,
      scroll: summarize(frameDeltas, {
        frames: frameDeltas.length,
        longFramesOver33ms: frameDeltas.filter((value) => value > 33.4).length,
      }),
      transfer: {
        batchPayloadBytes: workerMetrics.batchPayloadBytes,
        batchResponses: workerMetrics.batchResponses,
        protocolMessages: workerMetrics.protocolMessages,
        sourceRatio: workerMetrics.batchPayloadBytes / source.size,
      },
      memory: {
        api: memoryAvailable ? "measureUserAgentSpecificMemory" : "unavailable",
        forcedGcBeforeSample: forcedGcAvailable,
        peakDeltaBytes: memoryPeakDeltaBytes,
        samples: memory,
      },
    };
  } finally {
    pendingFirstDataPaint = null;
    view?.destroy();
    await table?.close().catch(() => {});
    await dataset?.close().catch(() => {});
    await engine?.close().catch(() => {});
    host.replaceChildren();
  }
}

function freshWorkerMetrics() {
  return {
    batchPayloadBytes: 0,
    batchResponses: 0,
    progress: [],
    protocolMessages: 0,
  };
}

function recordWorkerMessage(message) {
  workerMetrics.protocolMessages += 1;
  if (message?.event === "progress" && message.payload) {
    workerMetrics.progress.push({
      bytesScanned: Number(message.payload.bytesScanned),
      done: message.payload.done === true,
      rowsDiscovered: Number(message.payload.rowsDiscovered),
      timestamp: performance.now(),
    });
  }
  if (message?.status !== "success" || message.result?.kind !== "batch") {
    return;
  }
  let bytes = 0;
  for (const column of message.result.data?.columns ?? []) {
    for (const value of [column.data, column.offsets, column.validity]) {
      if (ArrayBuffer.isView(value)) bytes += value.byteLength;
      else if (value instanceof ArrayBuffer) bytes += value.byteLength;
    }
  }
  workerMetrics.batchPayloadBytes += bytes;
  workerMetrics.batchResponses += 1;
}

async function waitForCompletedScan(timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const completed = workerMetrics.progress.findLast(({ done }) => done);
    if (completed !== undefined) return completed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for completed source scan");
}

async function measureScrollFrames(scroller, count) {
  const frames = Math.max(1, Math.trunc(count));
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const deltas = [];
  let previous = await nextAnimationFrame();
  for (let index = 1; index <= frames; index += 1) {
    scroller.scrollTop = maximum * (index / frames);
    const timestamp = await nextAnimationFrame();
    deltas.push(timestamp - previous);
    previous = timestamp;
  }
  return deltas;
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function summarize(values, extra = {}) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("performance samples must be finite non-negative numbers");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    ...extra,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
  };
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      timeoutMs,
    )),
  ]);
}
