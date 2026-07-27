# DOCX provider proof of concept

The public package intentionally exports no DOCX provider yet. `provider-gate.json` is the machine-readable release decision: rwml wins only after every listed gate passes; BetterOffice is evaluated only if rwml fails; if neither passes, DOCX stays unpublished. Legacy `.doc` always requires a separate approval.

`rwml-bridge` is the smallest proposed WASM boundary. It accepts DOCX bytes, uses fixed bundled OFL fonts, returns preview-grade PDF bytes, exposes the renderer page count, and reports parser/render warnings. It is pinned to its own Rust 1.92 toolchain and does not change the repository workspace baseline.

The bridge is PoC source, not a shipped runtime asset. Do not copy it into `dist` or set `publish.docxProvider` until the licensed corpus, security corpus, browser, performance, size, and 100-cycle lifecycle evidence is committed.
