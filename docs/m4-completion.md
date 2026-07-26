# M4 completion record

M4 is complete at commit
[`1d79837f87d9af53e69cd8e31bfb7f55a82b83e3`](https://github.com/Ronbb/tabulark/commit/1d79837f87d9af53e69cd8e31bfb7f55a82b83e3)
(`feat: implement M4 adapter architecture`). It is a validation milestone, not
a registry release.

## Evidence

- GitHub Actions [CI run 30157486294](https://github.com/Ronbb/tabulark/actions/runs/30157486294)
  completed successfully on 2026-07-25. Its Rust, JavaScript, and Chromium
  Worker/accessibility/visual jobs were all successful.
- The Chromium job ran the browser integration suite, performance smoke,
  Arrow-delivery smoke, and size budget gate. It used the repository-pinned
  Playwright 1.61.1 Chromium delivery (149.0.7827.55).
- GitHub Pages [run 30157486264](https://github.com/Ronbb/tabulark/actions/runs/30157486264)
  completed successfully for the same commit. The build, deployment, and
  post-deploy deployed-URL smoke job all succeeded.
- The deployed playground is reachable at
  [https://ronbb.github.io/tabulark/](https://ronbb.github.io/tabulark/).

The evidence above covers the M4 CSV/TSV and Arrow IPC delivery surface only.
It must not be used as evidence for Parquet, Excel, or the later 0.1.0 release
train; those have their own gates in `docs/releasing.md`.

## Registry state

At the time this record was written, `tabulark` 0.1.0 was absent from npm and
crates.io. Existing 0.0.4 registry packages do not constitute a 0.1.0 release.
