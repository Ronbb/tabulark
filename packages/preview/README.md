# `@tabulark/preview` (P0)

Local-first, read-only previews for bounded structured text, code/text, and image sources. It is separate from the stable `tabulark` table ABI.

```js
import { createPreviewEngine } from "@tabulark/preview";

const engine = createPreviewEngine();
const session = await engine.open(file, { format: "auto", sourceName: file.name });
```

Sources may be `Blob`, `File`, `ArrayBuffer`, a view, or an explicit `RangeSource`. Signature and container checks take priority over file names. Sequential P0 formats are read only within `maxTextBytes`; the engine never silently downloads a whole `RangeSource` after that limit. All limits fail with structured `PreviewError` values using `RESOURCE_LIMIT`.

P0 supports JSON, JSONL, a safe YAML/TOML/XML subset, text/code formats, and PNG/JPEG/GIF/WebP/SVG/BMP/TIFF/HEIC metadata preview. SVG scripts, external resources, document types, and entities are rejected. PDF remains in the isolated experimental `@tabulark/document-preview` worker package while its random-access provider migration is completed.
