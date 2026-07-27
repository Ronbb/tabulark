# `@tabulark/document-preview` (experimental)

Local-only, Worker-backed paged document preview. This package is deliberately separate from the stable `tabulark` table ABI and official adapter manifest.

```js
import {
  createDocumentEngine,
  createPagedDocumentView,
  pdfProvider,
} from "@tabulark/document-preview";

const engine = await createDocumentEngine({ providers: [pdfProvider] });
const document = await engine.open(file, { sourceName: file.name });
const view = createPagedDocumentView({ container, document });
```

PDF parsing and rasterization use PDFium WebAssembly in a dedicated Worker. Pages are returned as temporary RGBA pixels and painted by the main thread. No file is uploaded, no remote module is loaded, and encrypted PDFs are rejected.

DOCX remains behind the rwml/BetterOffice proof-of-concept gate. It is intentionally not exported as a provider until a deterministic, fixed-font WASM build passes the fidelity, security, browser, size, and lifecycle corpus.

The v1 public boundary accepts only `Blob`, `File`, and `ArrayBuffer`. Text selection, search, annotations, printing, and image export are outside the first release.
