import {
  DocumentPreviewError,
  createDocumentEngine,
  createPagedDocumentView,
  pdfProvider,
} from "../../packages/document-preview/dist/index.js";

const picker = document.querySelector("#document-file");
const status = document.querySelector("#status");
const container = document.querySelector("#viewer");
let engine;
let session;
let view;
let opening;

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file !== undefined) void open(file);
});

window.addEventListener("pagehide", () => void closeAll());

async function open(file) {
  opening?.abort();
  const controller = new AbortController();
  opening = controller;
  status.textContent = `Opening ${file.name} locally…`;
  await closeDocument();
  try {
    engine ??= await createDocumentEngine({
      providers: [pdfProvider],
      assetBaseUrl: new URL("../../packages/document-preview/dist/", import.meta.url),
      memoryBudgetBytes: 256 * 1024 * 1024,
      maxInputBytes: 64 * 1024 * 1024,
      pageCacheBytes: 64 * 1024 * 1024,
      maxPagePixels: 8_000_000,
    });
    const opened = await engine.open(file, { sourceName: file.name, signal: controller.signal });
    if (controller.signal.aborted) { await opened.close(); return; }
    session = opened;
    view = createPagedDocumentView({
      container,
      document: opened,
      ariaLabel: `${file.name} page preview`,
      onError: (error) => { status.textContent = present(error); },
    });
    view.focus({ preventScroll: true });
    status.textContent = `${file.name}: ${opened.pageCount} ${opened.pageCount === 1 ? "page" : "pages"}.`;
  } catch (error) {
    if (controller.signal.aborted) return;
    status.textContent = present(error);
    container.innerHTML = `<div class="empty"><strong>Document could not open</strong><span>${recovery(error)}</span></div>`;
  } finally {
    if (opening === controller) opening = undefined;
  }
}

async function closeDocument() {
  const oldView = view;
  const oldSession = session;
  view = undefined;
  session = undefined;
  await oldView?.close();
  await oldSession?.close();
}

async function closeAll() {
  opening?.abort();
  opening = undefined;
  await closeDocument();
  await engine?.close();
  engine = undefined;
}

function present(error) {
  return error instanceof DocumentPreviewError ? `${error.code}: ${error.message}` : "The local document preview failed.";
}

function recovery(error) {
  if (error instanceof DocumentPreviewError && (error.code === "PASSWORD_REQUIRED" || error.code === "UNSUPPORTED_ENCRYPTION")) {
    return "Remove encryption from a copy of the PDF and try that local copy.";
  }
  if (error instanceof DocumentPreviewError && error.code === "RESOURCE_LIMIT") return "Choose a smaller PDF or reduce the render size.";
  return "Verify that the file is an unencrypted PDF, then try again.";
}
