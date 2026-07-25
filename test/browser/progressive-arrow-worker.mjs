const CONTROL_CHANNEL = "__tabularkProgressiveArrowTest";
const nativeSlice = Blob.prototype.slice;
const nativeArrayBuffer = Blob.prototype.arrayBuffer;
const sourceSlices = new WeakSet();

let completedSourceBytes = 0;
let sourceReadCount = 0;
let releaseBlockedRead;
let runtimeReady = false;
const startupMessages = [];
const blockedReadReleased = new Promise((resolve) => {
  releaseBlockedRead = resolve;
});

// Preserve the production Worker and WASM implementation while holding the
// second exact Blob byte action. The first 32 KiB action therefore publishes
// the committed Stream fixture's readable prefix, and the test controls when
// the remaining real bytes reach the adapter.
Blob.prototype.slice = function (...args) {
  const slice = nativeSlice.apply(this, args);
  sourceSlices.add(slice);
  return slice;
};

Blob.prototype.arrayBuffer = function (...args) {
  if (!sourceSlices.has(this)) {
    return nativeArrayBuffer.apply(this, args);
  }

  sourceReadCount += 1;
  const readActualBytes = () => nativeArrayBuffer.apply(this, args).then((bytes) => {
    completedSourceBytes += bytes.byteLength;
    return bytes;
  });
  if (sourceReadCount !== 2) {
    return readActualBytes();
  }

  globalThis.postMessage({
    [CONTROL_CHANNEL]: {
      kind: "source-read-blocked",
      completedSourceBytes,
      pendingSourceBytes: this.size,
      sourceReadCount,
    },
  });
  return blockedReadReleased.then(readActualBytes);
};

globalThis.addEventListener("message", (event) => {
  if (event.data?.[CONTROL_CHANNEL]?.kind === "release-source-read") {
    event.stopImmediatePropagation();
    releaseBlockedRead();
    return;
  }

  // A module Worker can receive the main thread's first `hello` while the
  // dynamic import below is suspended. Preserve protocol messages until the
  // production listener has been installed, then replay them in order. Stop
  // propagation during the small interval where that listener exists but the
  // import promise has not resolved, otherwise a message could be processed
  // once live and once again from this queue.
  if (!runtimeReady) {
    event.stopImmediatePropagation();
    startupMessages.push(event.data);
  }
});

await import("../../dist/worker.js");
runtimeReady = true;
for (const message of startupMessages.splice(0)) {
  globalThis.dispatchEvent(new MessageEvent("message", { data: message }));
}
