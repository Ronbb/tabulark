import {
  TabularkError,
  createCanvasTableView,
  createEngine,
  delimitedAdapter,
} from "../../dist/index.js";
import { arrowIpcAdapter } from "../../dist/arrow.js";
import { parquetAdapter } from "../../dist/parquet.js";
import { excelAdapter } from "../../dist/excel.js";
import { detectLocalFormat } from "./format-routing.js";

const ARROW_SAMPLE_URL = new URL(
  "../../test/fixtures/arrow/v1/m4-sample.arrow",
  import.meta.url,
);
const MAX_LARGE_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

const TERMINAL_ENGINE_CODES = new Set([
  "HANDLE_CLOSED",
  "PROTOCOL_INCOMPATIBLE",
  "RUNTIME_FAILURE",
  "UNSUPPORTED_RUNTIME",
]);

const STATE_LABELS = Object.freeze({
  idle: "Idle",
  opening: "Opening",
  indexing: "Indexing",
  ready: "Ready",
  cancelled: "Cancelled",
  error: "Error",
});

const app = document.querySelector("#app");
const form = document.querySelector("#open-form");
const filePicker = document.querySelector("#file-picker");
const sourceInput = document.querySelector("#source");
const formatInput = document.querySelector("#format");
const headerInput = document.querySelector("#header-mode");
const modeInput = document.querySelector("#parse-mode");
const delimiterInput = document.querySelector("#delimiter");
const delimiterHelp = document.querySelector("#delimiter-help");
const advanced = document.querySelector("#advanced");
const arrowOptions = document.querySelector("#arrow-options");
const arrowContainerInput = document.querySelector("#arrow-container");
const openButton = document.querySelector("#open");
const sampleButton = document.querySelector("#sample");
const arrowSampleButton = document.querySelector("#arrow-sample");
const cancelButton = document.querySelector("#cancel");
const retryButton = document.querySelector("#retry");
const fileName = document.querySelector("#file-name");
const fileSummary = document.querySelector("#file-summary");
const warningSummary = document.querySelector("#warning-summary");
const operationPanel = document.querySelector("#operation-panel");
const stateLabel = operationPanel.querySelector("[data-testid='state-label']");
const progress = document.querySelector("#progress");
const workspace = document.querySelector("#workspace");
const preview = document.querySelector("#preview");
const emptyState = document.querySelector("#empty-state");
const emptyTitle = document.querySelector("#empty-title");
const emptyMessage = document.querySelector("#empty-message");
const status = document.querySelector("#status");

const optionControls = [
  sourceInput,
  formatInput,
  headerInput,
  modeInput,
  delimiterInput,
  arrowContainerInput,
];

let currentState = "idle";
let engine;
let engineAdapterId;
let enginePromise;
let enginePromiseAdapterId;
let dataset;
let table;
let view;
let documentEngine;
let documentEnginePromise;
let documentSession;
let documentView;
let unsubscribeDataset;
let activeAbort;
let activeOperation = 0;
let engineGeneration = 0;
let mountedViewOperation = 0;
let completedIndexOperation = 0;
let completedRowCount = 0;
let lastSource;
let lastDisplayName = "";
let lastSourceSize = 0;
let actualCapabilitySummary = "";
let retrySource;
let activeSource;
let warningCount = 0;
let latestWarning = "";
let progressAnnouncementTimer = 0;
let pendingProgressAnnouncement = "";
let lastProgressAnnouncementAt = 0;
// File-format detection is intentionally kept in the playground layer. The
// public engine still requires an explicit official adapter, while this UI can
// choose one from the local file's metadata/signature before calling open().
let sourceSelectionRevision = 0;
let formatSelectionRevision = 0;
let pendingFormatDetection = Promise.resolve();
let detectedRoute;

sourceInput.addEventListener("change", () => {
  const source = sourceInput.files?.[0];
  if (source === undefined) {
    return;
  }
  const selectionRevision = ++sourceSelectionRevision;
  const formatRevision = formatSelectionRevision;
  detectedRoute = undefined;
  rememberSource(source, source.name);
  pendingFormatDetection = selectDetectedFormat(source, selectionRevision, formatRevision);
  updateSourceOptions();
  updateSourceSummary();
  if (currentState === "ready") {
    const modeLabel = typeof File !== "undefined" && source instanceof File
      ? "2 GiB local-file mode with bounded range reads"
      : "bounded source mode";
    setStatus(
      `Selected ${source.name} (${formatBytes(source.size)}), ${modeLabel}. The current preview remains open until you choose Open preview.`,
    );
  }
});

formatInput.addEventListener("change", () => {
  formatSelectionRevision += 1;
  detectedRoute = formatInput.value;
  actualCapabilitySummary = "";
  updateSourceOptions();
  updateSourceSummary();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const source = sourceInput.files?.[0];
  if (source === undefined) {
    sourceInput.click();
    return;
  }
  const selectionRevision = sourceSelectionRevision;
  // A signature read is asynchronous for files without a useful extension.
  // Wait for it so a fast click cannot open the source with the previous
  // (usually CSV) selection.
  void pendingFormatDetection.then(() => {
    if (selectionRevision !== sourceSelectionRevision) {
      return;
    }
    rememberSource(source, source.name);
    void openSource(source, source.name);
  });
});

sampleButton.addEventListener("click", () => {
  const sample = createSampleCsv(2_000);
  const source = new Blob([sample], { type: "text/csv" });
  sourceSelectionRevision += 1;
  pendingFormatDetection = Promise.resolve();
  detectedRoute = "csv";
  sourceInput.value = "";
  formatInput.value = "csv";
  headerInput.value = "first-row";
  modeInput.value = "lenient";
  delimiterInput.value = "";
  updateSourceOptions();
  rememberSource(source, "generated-sample.csv");
  void openSource(source, "generated-sample.csv");
});

arrowSampleButton.addEventListener("click", () => {
  sourceSelectionRevision += 1;
  pendingFormatDetection = Promise.resolve();
  detectedRoute = "arrow";
  void openArrowSample();
});

cancelButton.addEventListener("click", () => {
  void cancelCurrentOperation();
});

retryButton.addEventListener("click", () => {
  if (retrySource !== undefined) {
    void openSource(retrySource.source, retrySource.displayName);
  }
});

window.addEventListener("pagehide", () => {
  engineGeneration += 1;
  activeOperation += 1;
  activeAbort?.abort();
  activeAbort = undefined;
  const closingEngine = engine;
  const closingDocumentEngine = documentEngine;
  engine = undefined;
  engineAdapterId = undefined;
  enginePromise = undefined;
  enginePromiseAdapterId = undefined;
  documentEngine = undefined;
  documentEnginePromise = undefined;
  activeSource = undefined;
  void closeCurrentSession();
  void safelyClose(closingEngine);
  void safelyClose(closingDocumentEngine);
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) {
    return;
  }
  if (retrySource === undefined) {
    transition("idle", "Choose a local source; the playground detects its adapter before opening it.");
    showEmptyState(
      "No table open",
      "Choose a local CSV, TSV, Arrow IPC, Parquet, XLS, or XLSX source. The adapter is detected locally and nothing is uploaded.",
    );
    return;
  }
  transition(
    "cancelled",
    "The previous preview was closed while this page was in the browser history. Retry the local source to reopen it.",
    { focus: retryButton },
  );
  showEmptyState(
    "Preview closed",
    "Retry the same local source or choose another file.",
  );
});

updateSourceOptions();
renderState();

async function openArrowSample() {
  const operation = ++activeOperation;
  transition("opening", "Loading the pinned Arrow IPC sample…", { focus: cancelButton });
  showEmptyState(
    "Loading Arrow sample",
    "The committed fixture is being read from this static site before it is opened locally.",
  );
  try {
    const response = await fetch(ARROW_SAMPLE_URL);
    if (!response.ok) {
      throw new Error(`Arrow sample request failed with HTTP ${response.status}`);
    }
    // Keep the fixture on the Blob path too: the Playground should exercise
    // the same bounded local-source contract as a user-selected File, rather
    // than materialising the response as an ArrayBuffer on the main thread.
    const blob = await response.blob();
    if (!isCurrent(operation)) return;
    const source = new File([blob], "m4-sample.arrow", {
      type: "application/vnd.apache.arrow.file",
    });
    sourceInput.value = "";
    formatInput.value = "arrow";
    arrowContainerInput.value = "auto";
    updateSourceOptions();
    rememberSource(source, source.name);
    await openSource(source, source.name);
  } catch (error) {
    if (!isCurrent(operation)) return;
    transition("error", presentError(error), { focus: status });
    showEmptyState(
      "Arrow sample could not load",
      "Retry the sample or choose a local Arrow IPC file.",
    );
  }
}

async function openSource(source, displayName) {
  if (detectedRoute === "pdf") {
    await openPdfSource(source, displayName);
    return;
  }
  if (detectedRoute === "docx" || detectedRoute === "doc" || detectedRoute === "unknown-binary") {
    showRoutedFormat(detectedRoute, displayName);
    return;
  }
  rememberSource(source, displayName);
  const sourceSnapshot = Object.freeze({
    source,
    displayName,
    size: typeof source.size === "number" ? source.size : source.byteLength,
  });
  const sourceMode = typeof File !== "undefined" && source instanceof File
    ? "large"
    : "auto";
  retrySource = sourceSnapshot;
  activeSource = sourceSnapshot;
  const operation = ++activeOperation;
  completedIndexOperation = 0;
  completedRowCount = 0;
  const abort = new AbortController();
  activeAbort = abort;
  resetWarnings();
  transition(
    "opening",
    `Opening ${displayName} (${formatBytes(sourceSnapshot.size)})…`,
    { focus: cancelButton },
  );
  showEmptyState(
    "Opening local source",
    "The Worker is starting and requesting only the bounded byte ranges needed to open the preview.",
  );

  await closeCurrentSession();
  if (!isCurrent(operation)) {
    return;
  }

  if (sourceMode === "large" && sourceSnapshot.size > MAX_LARGE_SOURCE_BYTES) {
    const limitError = new TabularkError(
      "RESOURCE_LIMIT",
      `Large source mode supports local files up to ${formatBytes(MAX_LARGE_SOURCE_BYTES)}.`,
      {
        details: {
          resource: "source-staging",
          requiredBytes: sourceSnapshot.size,
          availableBytes: MAX_LARGE_SOURCE_BYTES,
        },
      },
    );
    transition("error", presentError(limitError), { focus: status });
    showEmptyState(
      "Source is too large",
      `Choose a local File no larger than ${formatBytes(MAX_LARGE_SOURCE_BYTES)}.`,
    );
    activeAbort = undefined;
    return;
  }

  let operationEngine;
  let openedDataset;
  try {
    const openOptions = readOpenOptions();
    operationEngine = await ensureEngine(openOptions.adapter);
    if (!isCurrent(operation)) {
      return;
    }

    openedDataset = await operationEngine.open(source, {
      ...openOptions,
      sourceMode,
      adapterOptions: {
        ...openOptions.adapterOptions,
        sourceName: displayName,
      },
      signal: abort.signal,
    });
    if (!isCurrent(operation)) {
      await safelyClose(openedDataset);
      return;
    }

    dataset = openedDataset;
    renderActualCapabilities();
    transition("indexing", `Preparing the first rows from ${displayName}…`);
    showEmptyState(
      "Preparing table preview",
      "The source is open. Tabulark is building the first viewport; sequential sources may continue indexing in the background.",
    );
    unsubscribeDataset = dataset.subscribe((event) => {
      handleDatasetEvent(event, operation, operationEngine, sourceSnapshot);
    });

    const descriptor = dataset.tables[0];
    if (descriptor === undefined) {
      throw new Error("The source did not expose a table");
    }
    const openedTable = await dataset.openTable(descriptor.id);
    if (!isCurrent(operation)) {
      await safelyClose(openedTable);
      return;
    }

    table = openedTable;
    renderActualCapabilities();
    view = createCanvasTableView({
      container: preview,
      table,
      ariaLabel: `${displayName} table preview`,
      // Keep the Canvas surface in step with the Playground's page palette.
      // The high-level view still defaults to light for compatibility outside
      // this demo; the Playground intentionally follows prefers-color-scheme.
      colorScheme: "auto",
      onError: (error) => handleViewError(error, operation),
    });
    mountedViewOperation = operation;
    emptyState.hidden = true;

    const rows = table.metadata.extent.rows;
    if (completedIndexOperation === operation) {
      finishReady(operation, sourceSnapshot, completedRowCount);
    } else if (rows.kind === "exact") {
      finishReady(operation, sourceSnapshot, rows.value);
    } else {
      transition(
        "indexing",
        `Preview ready. Indexing ${displayName}: at least ${formatCount(rows.value)} rows found.`,
      );
    }
    view.focus({ preventScroll: true });
  } catch (error) {
    if (!isCurrent(operation)) {
      return;
    }
    await closeCurrentSession();
    if (!isCurrent(operation)) {
      return;
    }
    if (errorCode(error) === "CANCELLED") {
      transition("cancelled", `Opening ${displayName} was cancelled.`, { focus: retryButton });
      showEmptyState(
        "Opening cancelled",
        "Adjust the adapter options or retry the same local source when you are ready.",
      );
      return;
    }

    if (isTerminalEngineError(error)) {
      await discardEngine(operationEngine);
      if (!isCurrent(operation)) {
        return;
      }
    }
    transition("error", presentError(error), { focus: status });
    showEmptyState(
      "Preview could not open",
      recoveryMessage(error),
    );
  } finally {
    if (isCurrent(operation) && activeAbort === abort) {
      activeAbort = undefined;
    }
  }
}

async function openPdfSource(source, displayName) {
  rememberSource(source, displayName);
  const sourceSnapshot = Object.freeze({ source, displayName, size: source.size });
  retrySource = sourceSnapshot;
  activeSource = sourceSnapshot;
  const operation = ++activeOperation;
  const abort = new AbortController();
  activeAbort = abort;
  resetWarnings();
  transition("opening", `Opening ${displayName} (${formatBytes(source.size)}) locally…`, {
    focus: cancelButton,
  });
  showEmptyState("Opening PDF", "PDFium WebAssembly is starting in a dedicated local Worker.");
  await closeCurrentSession();
  if (!isCurrent(operation)) return;

  try {
    const runtime = await import("../../packages/document-preview/dist/index.js");
    documentEngine ??= await ensureDocumentEngine(runtime);
    if (!isCurrent(operation)) return;
    const opened = await documentEngine.open(source, {
      sourceName: displayName,
      signal: abort.signal,
    });
    if (!isCurrent(operation)) {
      await safelyClose(opened);
      return;
    }
    documentSession = opened;
    documentView = runtime.createPagedDocumentView({
      container: preview,
      document: opened,
      ariaLabel: `${displayName} page preview`,
      onError: (error) => {
        if (isCurrent(operation)) setStatus(presentError(error), "error");
      },
    });
    emptyState.hidden = true;
    workspace.setAttribute("aria-label", "Document preview");
    transition(
      "ready",
      `${displayName}: ${opened.pageCount} ${opened.pageCount === 1 ? "page" : "pages"} ready.`,
    );
    activeAbort = undefined;
    documentView.focus({ preventScroll: true });
  } catch (error) {
    if (!isCurrent(operation)) return;
    await closeCurrentSession();
    activeAbort = undefined;
    transition("error", presentError(error), { focus: status });
    showEmptyState(
      "PDF could not open",
      errorCode(error) === "PASSWORD_REQUIRED" || errorCode(error) === "UNSUPPORTED_ENCRYPTION"
        ? "Remove encryption from a copy of the PDF and try that local copy."
        : "Verify that the file is an unencrypted PDF within the 64 MiB preview limit, then retry.",
    );
  }
}

async function ensureDocumentEngine(runtime) {
  if (documentEngine !== undefined) return documentEngine;
  documentEnginePromise ??= runtime.createDocumentEngine({
    providers: [runtime.pdfProvider],
    assetBaseUrl: new URL("../../packages/document-preview/dist/", import.meta.url),
    memoryBudgetBytes: 256 * 1024 * 1024,
    maxInputBytes: 64 * 1024 * 1024,
    pageCacheBytes: 64 * 1024 * 1024,
    maxPagePixels: 8_000_000,
  });
  try {
    documentEngine = await documentEnginePromise;
    return documentEngine;
  } finally {
    documentEnginePromise = undefined;
  }
}

async function cancelCurrentOperation() {
  if (currentState !== "opening" && currentState !== "indexing") {
    return;
  }
  const displayName = activeSource?.displayName ?? retrySource?.displayName ?? "the source";
  activeOperation += 1;
  activeAbort?.abort();
  activeAbort = undefined;
  transition("cancelled", `Opening ${displayName} was cancelled.`, { focus: retryButton });
  showEmptyState(
    "Opening cancelled",
    "Adjust the adapter options or retry the same local source when you are ready.",
  );
  await closeCurrentSession();
}

async function ensureEngine(adapter) {
  const adapterId = adapter.id;
  if (engine !== undefined && engineAdapterId === adapterId) {
    return engine;
  }
  if (enginePromise !== undefined && enginePromiseAdapterId === adapterId) {
    return enginePromise;
  }
  if (enginePromise !== undefined) {
    try {
      await enginePromise;
    } catch {
      // A subsequent request can still start the adapter it selected.
    }
    return ensureEngine(adapter);
  }
  if (engine !== undefined) {
    await discardEngine(engine);
  }

  const generation = engineGeneration;
  // Engine adapter allow-lists are immutable. Keeping only the selected
  // adapter also grants it the full bounded runtime pool instead of dividing
  // that pool among formats which are not active in the Playground.
  const pending = createEngine({
    adapters: [adapter],
  }).then(async (created) => {
    if (generation !== engineGeneration) {
      await safelyClose(created);
      throw cancellationError("Engine startup was cancelled because the page was hidden");
    }
    engine = created;
    engineAdapterId = adapterId;
    return created;
  });
  enginePromise = pending;
  enginePromiseAdapterId = adapterId;
  try {
    return await pending;
  } finally {
    if (enginePromise === pending) {
      enginePromise = undefined;
      enginePromiseAdapterId = undefined;
    }
  }
}

async function discardEngine(candidate = engine) {
  if (candidate === undefined) {
    return;
  }
  if (engine === candidate) {
    engine = undefined;
    engineAdapterId = undefined;
  }
  try {
    await candidate.close();
  } catch {
    // A terminal Worker failure may already have completed local cleanup.
  }
}

function handleDatasetEvent(event, operation, operationEngine, sourceSnapshot) {
  if (!isCurrent(operation)) {
    return;
  }
  if (event.type === "progress") {
    updateProgress(event.progress, operation, sourceSnapshot);
  } else if (event.type === "warning") {
    warningCount += 1;
    latestWarning = event.warning.message;
    renderWarnings();
  } else if (event.type === "metadata") {
    renderActualCapabilities();
  } else if (event.type === "runtimeError") {
    void handleDatasetFailure(event.error, operation, operationEngine);
  }
}

async function handleDatasetFailure(error, operation, operationEngine) {
  if (!isCurrent(operation)) {
    return;
  }
  activeAbort?.abort();
  activeAbort = undefined;
  if (isTerminalEngineError(error)) {
    await discardEngine(operationEngine);
  }
  if (!isCurrent(operation)) {
    return;
  }
  transition("error", presentError(error), { focus: status });
  if (view === undefined) {
    showEmptyState("Preview stopped", recoveryMessage(error));
  }
}

function handleViewError(error, operation) {
  if (!isCurrent(operation) || currentState === "error" || currentState === "cancelled") {
    return;
  }
  setStatus(`Preview action failed: ${errorMessage(error)}`, "error");
}

function updateProgress(runtimeProgress, operation, sourceSnapshot) {
  if (currentState === "error" || currentState === "cancelled") {
    return;
  }
  const bytesScanned = Math.max(0, runtimeProgress.bytesScanned);
  const rowsDiscovered = Math.max(0, runtimeProgress.rowsDiscovered);
  renderProgress(bytesScanned, sourceSnapshot.size);

  if (runtimeProgress.done) {
    completedIndexOperation = operation;
    completedRowCount = rowsDiscovered;
    if (!finishReady(operation, sourceSnapshot, rowsDiscovered)) {
      if (currentState !== "indexing") {
        setStateName("indexing");
      }
      setStatus(`Indexed ${sourceSnapshot.displayName}. Preparing the table preview…`);
    }
    return;
  }

  if (currentState !== "indexing") {
    setStateName("indexing");
  }
  const percentage = sourceSnapshot.size > 0
    ? ` (${Math.min(100, Math.floor((bytesScanned / sourceSnapshot.size) * 100))}%)`
    : "";
  scheduleProgressAnnouncement(
    `Indexing ${sourceSnapshot.displayName}: ${formatBytes(bytesScanned)} scanned${percentage}, ${formatCount(rowsDiscovered)} rows found.`,
    operation,
  );
}

function finishReady(operation, sourceSnapshot, rowCount) {
  if (
    !isCurrent(operation)
    || mountedViewOperation !== operation
    || view === undefined
    || currentState === "error"
    || currentState === "cancelled"
  ) {
    return false;
  }
  activeSource = undefined;
  transition("ready", readyMessage(sourceSnapshot.displayName, rowCount));
  return true;
}

function scheduleProgressAnnouncement(message, operation) {
  pendingProgressAnnouncement = message;
  const elapsed = performance.now() - lastProgressAnnouncementAt;
  if (elapsed >= 500) {
    flushProgressAnnouncement(operation);
    return;
  }
  if (progressAnnouncementTimer === 0) {
    progressAnnouncementTimer = window.setTimeout(() => {
      progressAnnouncementTimer = 0;
      flushProgressAnnouncement(operation);
    }, 500 - elapsed);
  }
}

function flushProgressAnnouncement(operation) {
  if (!isCurrent(operation) || currentState !== "indexing" || pendingProgressAnnouncement === "") {
    pendingProgressAnnouncement = "";
    return;
  }
  setStatus(pendingProgressAnnouncement);
  pendingProgressAnnouncement = "";
  lastProgressAnnouncementAt = performance.now();
}

function transition(state, message, { focus } = {}) {
  if (state !== "indexing") {
    cancelProgressAnnouncement();
  }
  setStateName(state);
  setStatus(message, state === "error" ? "error" : state === "cancelled" ? "cancelled" : "info");
  if (focus !== undefined) {
    queueMicrotask(() => {
      if (!focus.hidden && !focus.disabled) {
        focus.focus({ preventScroll: true });
      }
    });
  }
}

function setStateName(state) {
  currentState = state;
  app.dataset.state = state;
  operationPanel.dataset.state = state;
  stateLabel.textContent = STATE_LABELS[state];
  renderState();
}

function renderState() {
  const busy = currentState === "opening" || currentState === "indexing";
  const retryable = currentState === "cancelled" || currentState === "error";
  for (const control of optionControls) {
    control.disabled = busy;
  }
  advanced.toggleAttribute("data-disabled", busy);
  advanced.toggleAttribute("inert", busy);
  advanced.querySelector("summary")?.setAttribute("aria-disabled", String(busy));
  filePicker.toggleAttribute("data-disabled", busy);
  filePicker.toggleAttribute("inert", busy);
  filePicker.setAttribute("aria-disabled", String(busy));
  openButton.disabled = busy;
  sampleButton.disabled = busy;
  arrowSampleButton.disabled = busy;
  cancelButton.hidden = !busy;
  retryButton.hidden = !retryable || retrySource === undefined;
  openButton.textContent = currentState === "opening"
    ? "Opening…"
    : currentState === "indexing"
      ? "Indexing…"
      : "Open preview";
  workspace.setAttribute("aria-busy", String(busy));

  if (currentState === "opening") {
    progress.hidden = false;
    progress.removeAttribute("value");
    progress.setAttribute("aria-valuetext", "Starting the Worker and opening the source");
  } else if (currentState === "indexing") {
    progress.hidden = false;
  } else {
    progress.hidden = true;
  }
}

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function showEmptyState(title, message) {
  emptyTitle.textContent = title;
  emptyMessage.textContent = message;
  emptyState.hidden = false;
}

function showRoutedFormat(format, displayName) {
  activeOperation += 1;
  activeAbort?.abort();
  activeAbort = undefined;
  void closeCurrentSession();
  if (format === "pdf") {
    transition("error", `${displayName} is a PDF document. Choose Open preview to render it locally.`, { focus: status });
    showEmptyState("PDF ready to open", "Choose Open preview to render this PDF in the Playground.");
    return;
  }
  if (format === "docx") {
    transition("error", `${displayName} is a DOCX document, not an XLSX workbook.`, { focus: status });
    showEmptyState(
      "DOCX preview is gated",
      "The local WASM DOCX provider is not published until its fixed corpus passes. Save as PDF to use document preview today.",
    );
    return;
  }
  if (format === "doc") {
    transition("error", `${displayName} is a legacy Word document and is not supported.`, { focus: status });
    showEmptyState("Legacy DOC is unsupported", "Save the document as DOCX or PDF, then open the converted local file.");
    return;
  }
  transition("error", `${displayName} is an unrecognized binary file.`, { focus: status });
  showEmptyState(
    "Binary format not recognized",
    "Choose a supported table or document format. Unknown binary files are never passed to the CSV parser.",
  );
}

function rememberSource(source, displayName) {
  if (source !== lastSource) {
    actualCapabilitySummary = "";
  }
  lastSource = source;
  lastDisplayName = displayName || source.name || "local source";
  lastSourceSize = typeof source.size === "number" ? source.size : source.byteLength;
  fileName.textContent = lastDisplayName;
  fileName.title = lastDisplayName;
  updateSourceSummary();
}

/**
 * Inspect the bounded local container structure before selecting a route.
 * Structure wins over misleading names and MIME hints.
 */
async function selectDetectedFormat(source, selectionRevision, formatRevision) {
  let format;
  try {
    format = await detectLocalFormat(source);
  } catch {
    format = "unknown-binary";
  }
  if (selectionRevision !== sourceSelectionRevision || formatRevision !== formatSelectionRevision) return format;
  detectedRoute = format;
  if (format !== undefined && !["pdf", "docx", "doc", "unknown-binary"].includes(format)) {
    applyDetectedFormat(format, selectionRevision, formatRevision);
  } else {
    updateSourceSummary();
  }
  return format;
}

function applyDetectedFormat(format, selectionRevision, formatRevision) {
  if (
    selectionRevision !== sourceSelectionRevision
    || formatRevision !== formatSelectionRevision
  ) {
    return;
  }
  formatInput.value = format;
  updateSourceOptions();
  updateSourceSummary();
}

function updateSourceSummary() {
  if (lastSource === undefined) {
    fileSummary.textContent = "No source selected.";
    return;
  }
  const routedFormat = detectedRoute ?? formatInput.value;
  const formatLabel = routedFormat === "arrow" ? "ARROW IPC" : routedFormat.toUpperCase();
  const isLocalFile = typeof File !== "undefined" && lastSource instanceof File;
  const modeLabel = isLocalFile
    ? `2 GiB local-file mode · ${lastSourceSize <= MAX_LARGE_SOURCE_BYTES ? "within limit" : "over limit"}`
    : "bounded source mode";
  const capability = actualCapabilitySummary || `estimated ${estimateCapability(routedFormat, isLocalFile, lastSourceSize)}`;
  fileSummary.textContent = `${lastDisplayName} · ${formatBytes(lastSourceSize)} · ${formatLabel} · ${modeLabel} · ${formatCount(lastSourceSize)} bytes exact · ${capability}`;
}

function renderActualCapabilities() {
  if (dataset === undefined) {
    return;
  }
  const datasetCapabilities = dataset.getCapabilities();
  const tableCapabilities = table?.getCapabilities();
  actualCapabilitySummary = [
    `actual ${datasetCapabilities.sourceAccess}`,
    tableCapabilities?.randomAccess,
    datasetCapabilities.progressive ? "progressive" : "indexed open",
    datasetCapabilities.multiTable ? "multi-table" : "single-table",
    datasetCapabilities.presentation ? "presentation" : "data only",
  ].filter(Boolean).join(" · ");
  updateSourceSummary();
}

function estimateCapability(format, isLocalFile, sourceSize) {
  if (isLocalFile && sourceSize > MAX_LARGE_SOURCE_BYTES) {
    return "open blocked above 2 GiB";
  }
  switch (format) {
    case "csv":
    case "tsv":
      return "streaming scan";
    case "arrow":
      return arrowContainerInput.value === "stream" ? "progressive IPC scan" : "bounded IPC ranges";
    case "parquet":
      return "footer and row-group ranges";
    case "xlsx":
      return isLocalFile ? "range-backed OOXML" : "bounded workbook staging";
    case "xls":
      return isLocalFile ? "range-backed BIFF8/CFB" : "bounded BIFF8 staging";
    default:
      return "bounded adapter access";
  }
}

function updateSourceOptions() {
  const isArrow = formatInput.value === "arrow";
  const isDelimited = formatInput.value === "csv" || formatInput.value === "tsv";
  advanced.hidden = !isDelimited;
  arrowOptions.hidden = !isArrow;
  delimiterHelp.textContent = formatInput.value === "tsv"
    ? "Leave blank for a tab. Use \\t to enter a tab explicitly."
    : "Leave blank for comma. Use \\t for a tab.";
}

function readOpenOptions() {
  if (formatInput.value === "arrow") {
    return {
      adapter: arrowIpcAdapter,
      adapterOptions: {
        container: arrowContainerInput.value,
      },
    };
  }
  if (formatInput.value === "parquet") {
    return { adapter: parquetAdapter, adapterOptions: {} };
  }
  if (formatInput.value === "xls" || formatInput.value === "xlsx") {
    return {
      adapter: excelAdapter,
      adapterOptions: { format: formatInput.value },
    };
  }
  const adapterOptions = {
    dialect: formatInput.value,
    header: headerInput.value,
    mode: modeInput.value,
  };
  if (delimiterInput.value !== "") {
    adapterOptions.delimiter = delimiterInput.value === "\\t" ? "\t" : delimiterInput.value;
  }
  return { adapter: delimitedAdapter, adapterOptions };
}

function resetWarnings() {
  warningCount = 0;
  latestWarning = "";
  renderWarnings();
}

function renderWarnings() {
  warningSummary.hidden = warningCount === 0;
  warningSummary.textContent = warningCount === 0
    ? ""
    : `${formatCount(warningCount)} parsing ${warningCount === 1 ? "warning" : "warnings"}. Latest: ${latestWarning}`;
}

function renderProgress(bytesScanned, totalBytes) {
  progress.hidden = false;
  if (totalBytes > 0) {
    progress.max = totalBytes;
    progress.value = Math.min(totalBytes, bytesScanned);
    progress.setAttribute(
      "aria-valuetext",
      `${formatBytes(bytesScanned)} of ${formatBytes(totalBytes)} scanned`,
    );
  } else {
    progress.removeAttribute("value");
    progress.setAttribute("aria-valuetext", `${formatBytes(bytesScanned)} scanned`);
  }
}

function readyMessage(displayName, rowCount) {
  const warningText = warningCount === 0
    ? ""
    : ` ${formatCount(warningCount)} parsing ${warningCount === 1 ? "warning was" : "warnings were"} reported.`;
  if (rowCount === 0) {
    return `Opened ${displayName}. The source contains no data rows.${warningText}`;
  }
  return `Opened ${displayName}. ${formatCount(rowCount)} rows are ready.${warningText} Use arrow keys to explore the table.`;
}

function presentError(error) {
  const code = errorCode(error);
  const details = error?.details;
  if (
    code === "RESOURCE_LIMIT"
    && details !== null
    && typeof details === "object"
    && typeof details.resource === "string"
    && Number.isFinite(details.requiredBytes)
    && Number.isFinite(details.availableBytes)
  ) {
    return `${code}: ${errorMessage(error)} (${details.resource}; required ${formatBytes(details.requiredBytes)}, available ${formatBytes(details.availableBytes)})`;
  }
  return `${code}: ${errorMessage(error)}`;
}

function recoveryMessage(error) {
  if (errorCode(error) === "RESOURCE_LIMIT") {
    return "Choose a smaller local File or reduce the requested range; the configured source and memory limits remain unchanged.";
  }
  if (errorCode(error) === "PARSE_FAILED") {
    return "Review the delimiter, header, or malformed-row setting, then retry the same local source.";
  }
  if (errorCode(error) === "UNSUPPORTED_FEATURE") {
    return "This source uses a format feature outside the 0.1 preview contract. Choose another local source or supported variant.";
  }
  if (isTerminalEngineError(error)) {
    return "The Worker stopped. Retry will start a fresh Worker and reopen the same local source.";
  }
  return "Review the adapter options or choose another local source, then retry.";
}

function isTerminalEngineError(error) {
  return TERMINAL_ENGINE_CODES.has(errorCode(error));
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "ERROR";
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}

function isCurrent(operation) {
  return operation === activeOperation;
}

function cancelProgressAnnouncement() {
  if (progressAnnouncementTimer !== 0) {
    window.clearTimeout(progressAnnouncementTimer);
    progressAnnouncementTimer = 0;
  }
  pendingProgressAnnouncement = "";
}

async function closeCurrentSession() {
  unsubscribeDataset?.();
  unsubscribeDataset = undefined;

  const closingView = view;
  const closingTable = table;
  const closingDataset = dataset;
  const closingDocumentView = documentView;
  const closingDocumentSession = documentSession;
  view = undefined;
  table = undefined;
  dataset = undefined;
  documentView = undefined;
  documentSession = undefined;
  mountedViewOperation = 0;

  closingView?.destroy();
  await safelyClose(closingDocumentView);
  preview.replaceChildren();
  await safelyClose(closingTable);
  await safelyClose(closingDataset);
  await safelyClose(closingDocumentSession);
  workspace.setAttribute("aria-label", "Table preview");
}

async function safelyClose(resource) {
  try {
    await resource?.close();
  } catch {
    // Cleanup remains best-effort after cancellation or a terminal Worker failure.
  }
}

function cancellationError(message) {
  const error = new Error(message);
  error.code = "CANCELLED";
  return error;
}

function createSampleCsv(rowCount) {
  const departments = ["Research", "Operations", "Design", "Customer success"];
  const statuses = ["Ready", "In review", "Blocked"];
  const rows = ["id,name,department,status,score,updated"];
  for (let index = 1; index <= rowCount; index += 1) {
    rows.push(
      [
        index,
        `Record ${index}`,
        departments[index % departments.length],
        statuses[index % statuses.length],
        70 + (index % 31),
        `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
      ].join(","),
    );
  }
  return rows.join("\n");
}

function formatBytes(value) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value);
}
