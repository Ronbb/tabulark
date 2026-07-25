# Delivery and release policy

> **M4 does not publish a crate or npm package.** It is a pre-alpha validation
> milestone. Do not create a tag, change registry ownership, publish to
> crates.io/npm, or call the milestone complete merely because a local build
> succeeds.

## Candidate delivery gates

For a commit to be considered an M4 delivery candidate, all of the following
must be green for that same commit:

1. Rust formatting, Clippy, workspace tests, adapter lifecycle checks, fuzz
   seed replay, and `wasm32-unknown-unknown` checks for both wrapper crates.
2. JavaScript type checks, protocol/fixture/lifecycle tests, package-consumer
   smoke, and a clean `npm run build`.
3. Chromium Worker, Arrow, Canvas, ARIA, axe, visual, forced-colors, CJK,
   keyboard/copy, mobile, and lazy-artifact tests.
4. CSV and Arrow performance/size measurement gates. The M3 CSV canonical
   baseline remains intact; Arrow has its own measurements and budget.
5. A Pages assembly from the built package with relative URLs, both WASM
   artifacts, fixture/provenance/license/notice assets, and local artifact
   browser tests before upload.
6. GitHub Pages deployment followed by a smoke test against the actual URL
   returned by the deployment action. That smoke opens CSV, TSV, and Arrow,
   switches sources, copies from the semantic grid, checks console/page errors,
   and verifies lazy artifact network behavior.

The first five gates can establish a local or pull-request candidate. The sixth
is mandatory production evidence and cannot be inferred from a test server.

## Local verification sequence

```sh
npm ci
npm run build
npm run check
npm run test:browser
npm run benchmark:smoke
npm run benchmark:arrow
npm run benchmark:size
npm run build:pages
```

The exact complete test matrix and any platform caveats are documented in
[Testing and performance validation](testing.md). `benchmark:canonical` is
intentionally a fuller CSV reference benchmark; it is not substituted by the
small smoke scenario.

## Package contents

The packed archive must contain:

- The `tabulark` root entry point and `tabulark/arrow` subpath export.
- JavaScript, declarations, and source maps for the root, Arrow entry, and
  generic Worker.
- Delimited and Arrow WASM glue, declaration files, and `.wasm` payloads.
- MIT/Apache licenses and `THIRD_PARTY_NOTICES.md`.

`scripts/package-smoke.mjs` packs the built tree, installs it into a temporary
consumer, checks the export map and exact files, verifies there are no
production dependencies, imports both public entry points, and typechecks a
consumer snippet.

## Static Pages delivery

`npm run build:pages` creates `target/pages` with no CDN runtime dependency and
only relative internal URLs. It contains the built package runtime, Arrow
fixtures and provenance, licenses, notice, and the static Playground. The Pages
workflow tests this assembled directory before `upload-pages-artifact`.

The deployment job receives the URL output from `actions/deploy-pages` and runs
the dedicated deployed Pages test with `TABULARK_DEPLOYED_BASE_URL`. If the
deployment cannot be reached, the job fails; a skipped or missing deployed URL
does not count as M4 evidence.

## Future formal releases

The repository may retain a tag-triggered formal release workflow for a later
milestone, but that workflow is not authorization to publish M4. Before a
future release is proposed, explicitly decide and record:

- The public API and adapter-ABI stability policy.
- Semver versioning and changelog policy.
- Registry ownership and trusted publishing configuration.
- Supported browsers, source formats, compression/type guarantees, and
  compatibility horizon.
- Reproducible artifact provenance, notices, and security-review process.

Until then, source builds and GitHub Pages candidates are the only intended M4
delivery channels.
