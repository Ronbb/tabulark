import { createCanvasTableView, createEngine } from "../../dist/index.js";

const form = document.querySelector("#open-form");
const sourceInput = document.querySelector("#source");
const formatInput = document.querySelector("#format");
const openButton = document.querySelector("#open");
const sampleButton = document.querySelector("#sample");
const fileName = document.querySelector("#file-name");
const preview = document.querySelector("#preview");
const emptyState = document.querySelector("#empty-state");
const status = document.querySelector("#status");

let engine;
let dataset;
let table;
let view;
let unsubscribeDataset;

sourceInput.addEventListener("change", () => {
  const source = sourceInput.files?.[0];
  fileName.textContent = source?.name ?? "Choose a file";
  if (source?.name.toLowerCase().endsWith(".tsv")) {
    formatInput.value = "tsv";
  } else if (source?.name.toLowerCase().endsWith(".csv")) {
    formatInput.value = "csv";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const source = sourceInput.files?.[0];
  if (source === undefined) {
    sourceInput.click();
    return;
  }
  await openSource(source, formatInput.value);
});

sampleButton.addEventListener("click", async () => {
  const sample = createSampleCsv(2_000);
  fileName.textContent = "generated-sample.csv";
  formatInput.value = "csv";
  await openSource(new Blob([sample], { type: "text/csv" }), "csv", "generated sample");
});

window.addEventListener("pagehide", () => {
  view?.destroy();
  void closeCurrentSession();
  void engine?.close();
});

async function openSource(source, format, displayName = source.name) {
  setBusy(true);
  setStatus(`Opening ${displayName}…`);

  try {
    await closeCurrentSession();
    engine ??= await createEngine();
    dataset = await engine.open(source, {
      format,
      header: "first-row",
      mode: "lenient",
    });
    unsubscribeDataset = dataset.subscribe((event) => {
      if (event.type === "progress") {
        const { bytesScanned, rowsDiscovered, done } = event.progress;
        setStatus(
          done
            ? `Indexed ${formatCount(rowsDiscovered)} rows.`
            : `Indexing… ${formatBytes(bytesScanned)}, ${formatCount(rowsDiscovered)} rows found`,
        );
      } else if (event.type === "warning") {
        setStatus(event.warning.message);
      } else if (event.type === "runtimeError") {
        setStatus(event.error.message, "error");
      }
    });

    table = await dataset.openTable(dataset.tables[0].id);
    view = createCanvasTableView({ container: preview, table });
    emptyState.hidden = true;
    setStatus(`Opened ${displayName}. Use arrow keys to explore the table.`);
    view.focus();
  } catch (error) {
    await closeCurrentSession();
    emptyState.hidden = false;
    setStatus(`${error?.code ?? "ERROR"}: ${error?.message ?? error}`, "error");
  } finally {
    setBusy(false);
  }
}

async function closeCurrentSession() {
  unsubscribeDataset?.();
  unsubscribeDataset = undefined;
  view?.destroy();
  view = undefined;
  preview.replaceChildren();
  await table?.close();
  await dataset?.close();
  table = undefined;
  dataset = undefined;
}

function setBusy(busy) {
  openButton.disabled = busy;
  sampleButton.disabled = busy;
  openButton.textContent = busy ? "Opening…" : "Open preview";
}

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
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
