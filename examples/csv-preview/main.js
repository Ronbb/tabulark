import {
  createCanvasTableView,
  createEngine,
  delimitedAdapter,
} from "../../dist/index.js";
import { arrowIpcAdapter } from "../../dist/arrow.js";

const ARROW_SAMPLE_URL = new URL(
  "../../test/fixtures/arrow/v1/m4-sample.arrow",
  import.meta.url,
);

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
let enginePromise;
let dataset;
let table;
let view;
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
let retrySource;
let activeSource;
let warningCount = 0;
let latestWarning = "";
let progressAnnouncementTimer = 0;
let pendingProgressAnnouncement = "";
let lastProgressAnnouncementAt = 0;

sourceInput.addEventListener("change", () => {
  const source = sourceInput.files?.[0];
  if (source === undefined) {
    return;
  }
  rememberSource(source, source.name);
  updateSourceOptions();
  updateSourceSummary();
  if (currentState === "ready") {
    setStatus(
      `Selected ${source.name} (${formatBytes(source.size)}). The current preview remains open until you choose Open preview.`,
    );
  }
});

formatInput.addEventListener("change", () => {
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
  rememberSource(source, source.name);
  void openSource(source, source.name);
});

sampleButton.addEventListener("click", () => {
  const sample = createSampleCsv(2_000);
  const source = new Blob([sample], { type: "text/csv" });
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
  engine = undefined;
  enginePromise = undefined;
  activeSource = undefined;
  void closeCurrentSession();
  void safelyClose(closingEngine);
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) {
    return;
  }
  if (retrySource === undefined) {
    transition("idle", "Choose CSV, TSV, or Arrow IPC explicitly, then open a local source or sample.");
    showEmptyState(
      "No table open",
      "Choose a local CSV, TSV, or Arrow IPC source. Nothing is uploaded.",
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
    const bytes = await response.arrayBuffer();
    if (!isCurrent(operation)) return;
    const source = new File([bytes], "m4-sample.arrow", {
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
  rememberSource(source, displayName);
  const sourceSnapshot = Object.freeze({
    source,
    displayName,
    size: typeof source.size === "number" ? source.size : source.byteLength,
  });
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

  let operationEngine;
  let openedDataset;
  try {
    operationEngine = await ensureEngine();
    if (!isCurrent(operation)) {
      return;
    }

    const openOptions = readOpenOptions();
    openedDataset = await operationEngine.open(source, {
      ...openOptions,
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
    view = createCanvasTableView({
      container: preview,
      table,
      ariaLabel: `${displayName} table preview`,
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

async function ensureEngine() {
  if (engine !== undefined) {
    return engine;
  }
  if (enginePromise !== undefined) {
    return enginePromise;
  }

  const generation = engineGeneration;
  const pending = createEngine({ adapters: [delimitedAdapter, arrowIpcAdapter] }).then(async (created) => {
    if (generation !== engineGeneration) {
      await safelyClose(created);
      throw cancellationError("Engine startup was cancelled because the page was hidden");
    }
    engine = created;
    return created;
  });
  enginePromise = pending;
  try {
    return await pending;
  } finally {
    if (enginePromise === pending) {
      enginePromise = undefined;
    }
  }
}

async function discardEngine(candidate = engine) {
  if (candidate === undefined) {
    return;
  }
  if (engine === candidate) {
    engine = undefined;
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

function rememberSource(source, displayName) {
  lastSource = source;
  lastDisplayName = displayName || source.name || "local source";
  lastSourceSize = typeof source.size === "number" ? source.size : source.byteLength;
  fileName.textContent = lastDisplayName;
  fileName.title = lastDisplayName;
  updateSourceSummary();
}

function updateSourceSummary() {
  if (lastSource === undefined) {
    fileSummary.textContent = "No source selected.";
    return;
  }
  const formatLabel = formatInput.value === "arrow" ? "ARROW IPC" : formatInput.value.toUpperCase();
  fileSummary.textContent = `${lastDisplayName} · ${formatBytes(lastSourceSize)} · ${formatLabel}`;
}

function updateSourceOptions() {
  const isArrow = formatInput.value === "arrow";
  advanced.hidden = isArrow;
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
  return `${errorCode(error)}: ${errorMessage(error)}`;
}

function recoveryMessage(error) {
  if (errorCode(error) === "PARSE_FAILED") {
    return "Review the delimiter, header, or malformed-row setting, then retry the same local source.";
  }
  if (errorCode(error) === "UNSUPPORTED_FEATURE") {
    return "This Arrow source uses a feature the current IPC adapter cannot decode. Choose another source or container mode.";
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
  view = undefined;
  table = undefined;
  dataset = undefined;
  mountedViewOperation = 0;

  closingView?.destroy();
  preview.replaceChildren();
  await safelyClose(closingTable);
  await safelyClose(closingDataset);
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
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value);
}
