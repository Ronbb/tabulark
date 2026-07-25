import {
  createCanvasTableView,
  createEngine,
  delimitedAdapter,
} from "../../dist/index.js";
import { arrowIpcAdapter } from "../../dist/arrow.js";

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
    && (
      pendingFirstDataPaint.expectedText === undefined
      || text === pendingFirstDataPaint.expectedText
    )
  ) {
    const { resolve } = pendingFirstDataPaint;
    pendingFirstDataPaint = null;
    requestAnimationFrame((timestamp) => resolve(timestamp));
  }
  return result;
};

globalThis.__tabularkRunPerformanceScenario = runScenario;
globalThis.__tabularkRunArrowPerformanceScenario = runArrowScenario;
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
    engine = await createEngine({
      adapters: [delimitedAdapter],
      memoryBudgetBytes: 128 * 1024 * 1024,
    });
    const workerWasmStartupMs = performance.now() - startupStart;
    await measureMemory("engine-ready");

    const openStart = performance.now();
    dataset = await engine.open(source, {
      adapter: delimitedAdapter,
      adapterOptions: {
        dialect: "csv",
        header: "first-row",
        mode: "strict",
        sourceName: source.name,
      },
    });
    table = await dataset.openTable(dataset.tables[0].id);

    const firstPaint = new Promise((resolve) => {
      pendingFirstDataPaint = { expectedText: "name-1", resolve };
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
    const scrollMeasurement = await measureScrollFrames(scroller, scrollFrames);
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
      scroll: summarize(scrollMeasurement.frameDeltas, {
        frames: scrollMeasurement.frameDeltas.length,
        longFramesOver33ms: scrollMeasurement.frameDeltas.filter((value) => value > 33.4).length,
        maximumScrollTop: scrollMeasurement.maximumScrollTop,
        maximumObservedScrollTop: scrollMeasurement.maximumObservedScrollTop,
        finalScrollTop: scrollMeasurement.finalScrollTop,
        changedFrames: scrollMeasurement.changedFrames,
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

/**
 * Measures the Arrow delivery path without generating an IPC file in browser
 * JavaScript. The runner supplies a SHA-pinned local fixture through #source.
 *
 * The metric names deliberately distinguish engine construction (which must
 * not fetch WASM) from the first Arrow `open`, which includes the one-time
 * artifact load and initial metadata work. Future Stream/LZ4/Zstd fixtures use
 * this same harness by changing the manifest container and fixture path.
 */
async function runArrowScenario({
  container = "auto",
  expectedColumns,
  expectedFirstDataText,
  expectedRows,
  randomRangeRows,
  requireMemory = true,
  scrollFrames = 60,
} = {}) {
  const input = document.querySelector("#source");
  const host = document.querySelector("#host");
  const source = input?.files?.[0];
  if (!(source instanceof File) || !(host instanceof HTMLElement)) {
    throw new Error("Arrow performance harness requires a File input and host element");
  }
  if (!crossOriginIsolated) {
    throw new Error("Arrow performance harness must run with COOP/COEP isolation");
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
      throw new Error(`invalid Arrow memory measurement for ${phase}`);
    }
    memory.push({ phase, bytes: measurement.bytes });
  };

  let engine;
  let dataset;
  let table;
  let view;
  try {
    await measureMemory("idle");
    const engineStart = performance.now();
    engine = await createEngine({
      adapters: [delimitedAdapter, arrowIpcAdapter],
      memoryBudgetBytes: 128 * 1024 * 1024,
    });
    const engineStartupMs = performance.now() - engineStart;
    await measureMemory("engine-ready");

    const openStart = performance.now();
    dataset = await engine.open(source, {
      adapter: arrowIpcAdapter,
      adapterOptions: { container, sourceName: source.name },
    });
    const adapterColdOpenMs = performance.now() - openStart;
    table = await dataset.openTable(dataset.tables[0].id);
    await measureMemory("adapter-open");

    if (Number.isSafeInteger(expectedRows) && table.metadata.extent.rows.kind === "exact") {
      if (table.metadata.extent.rows.value !== expectedRows) {
        throw new Error(`Arrow row count mismatch: expected ${expectedRows}, got ${table.metadata.extent.rows.value}`);
      }
    }
    if (Number.isSafeInteger(expectedColumns) && table.metadata.schema.columns.length !== expectedColumns) {
      throw new Error(
        `Arrow column count mismatch: expected ${expectedColumns}, got ${table.metadata.schema.columns.length}`,
      );
    }

    const firstPaint = new Promise((resolve) => {
      pendingFirstDataPaint = { expectedText: expectedFirstDataText, resolve };
    });
    view = createCanvasTableView({
      container: host,
      table,
      maxDevicePixelRatio: 1,
      controllerOptions: { overscanColumns: 0, overscanRows: 4 },
    });

    const firstUsablePaintMs = (await withTimeout(
      firstPaint,
      30_000,
      expectedFirstDataText === undefined
        ? "first usable Arrow Canvas paint"
        : `Arrow Canvas paint for ${expectedFirstDataText}`,
    )) - openStart;
    await measureMemory("first-paint");

    const rowCount = Number.isSafeInteger(expectedRows)
      ? expectedRows
      : table.metadata.extent.rows.kind === "exact"
        ? table.metadata.extent.rows.value
        : 0;
    const columnCount = table.metadata.schema.columns.length;
    const starts = normalizedRangeStarts(randomRangeRows, rowCount);
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
    await measureMemory("range-read");

    const scroller = view.element.querySelector("[data-tabulark-scroll]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Arrow Canvas view did not expose its scroll host");
    }
    const scrollMeasurement = await measureScrollFrames(scroller, scrollFrames);
    await nextAnimationFrame();
    await measureMemory("scroll-complete");
    const randomAccess = table.metadata.capabilities.randomAccess;

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
      adapter: {
        container,
        randomAccess,
        sourceBytes: source.size,
      },
      coldLoad: {
        engineStartupMs,
        adapterColdOpenMs,
        firstUsablePaintMs,
      },
      rangeRead: summarize(rangeReadMs, { samples: rangeReadMs, starts }),
      rangeBatchBytes,
      scroll: summarize(scrollMeasurement.frameDeltas, {
        frames: scrollMeasurement.frameDeltas.length,
        longFramesOver33ms: scrollMeasurement.frameDeltas.filter((value) => value > 33.4).length,
        maximumScrollTop: scrollMeasurement.maximumScrollTop,
        maximumObservedScrollTop: scrollMeasurement.maximumObservedScrollTop,
        finalScrollTop: scrollMeasurement.finalScrollTop,
        changedFrames: scrollMeasurement.changedFrames,
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

function normalizedRangeStarts(requested, rowCount) {
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) return [0];
  const raw = Array.isArray(requested) && requested.length > 0
    ? requested
    : [0, Math.floor(rowCount / 2), rowCount - 1];
  const starts = [];
  for (const value of raw) {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Arrow random range starts must be safe integers");
    }
    const normalized = Math.max(0, Math.min(rowCount - 1, value));
    if (!starts.includes(normalized)) starts.push(normalized);
  }
  return starts;
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
  for (const value of message.result.data?.buffers ?? []) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    else if (value instanceof ArrayBuffer) bytes += value.byteLength;
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
  const recent = workerMetrics.progress.slice(-5).map((entry) => ({
    bytesScanned: entry.bytesScanned,
    done: entry.done,
    rowsDiscovered: entry.rowsDiscovered,
  }));
  throw new Error(
    `timed out waiting for completed source scan; recent progress=${JSON.stringify(recent)}`,
  );
}

async function measureScrollFrames(scroller, count) {
  const frames = Math.max(1, Math.trunc(count));
  const maximumScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (maximumScrollTop <= 0) {
    throw new Error("performance scroll fixture does not overflow the Canvas viewport");
  }

  scroller.scrollTop = 0;
  await nextAnimationFrame();
  const initialScrollTop = scroller.scrollTop;
  const frameDeltas = [];
  let changedFrames = 0;
  let maximumObservedScrollTop = initialScrollTop;
  let previousScrollTop = initialScrollTop;
  let previous = await nextAnimationFrame();
  for (let index = 1; index <= frames; index += 1) {
    scroller.scrollTop = maximumScrollTop * (index / frames);
    const timestamp = await nextAnimationFrame();
    const observedScrollTop = scroller.scrollTop;
    if (observedScrollTop !== previousScrollTop) changedFrames += 1;
    maximumObservedScrollTop = Math.max(maximumObservedScrollTop, observedScrollTop);
    previousScrollTop = observedScrollTop;
    frameDeltas.push(timestamp - previous);
    previous = timestamp;
  }
  const finalScrollTop = scroller.scrollTop;
  if (
    initialScrollTop !== 0
    || changedFrames === 0
    || maximumObservedScrollTop <= 0
    || finalScrollTop <= 0
  ) {
    throw new Error("performance scroll measurement did not move the Canvas scroll host");
  }
  return {
    frameDeltas,
    maximumScrollTop,
    maximumObservedScrollTop,
    finalScrollTop,
    changedFrames,
  };
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
