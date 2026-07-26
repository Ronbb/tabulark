# 0.1.0 release evidence

This record closes the 0.1.0 release train. It is deliberately separate from
the M4 completion record: M4 was an implementation milestone, while this file
records the artifact and registry evidence for the published release.

## Immutable source

- Tag: `v0.1.0`
- Target commit: `f10e40b0c51627676cbcaa87a07d14219db31eb2`
- The tag is treated as immutable. It must not be moved, force-updated, or
  reused for a later patch release. The current `main` fixes release-recovery
  automation and is intentionally newer than the tag.

## Protected runs

The prerequisite runs completed for the exact tag target:

| Check | Run | Result |
| --- | ---: | --- |
| CI | [30188020468](https://github.com/Ronbb/tabulark/actions/runs/30188020468) | success |
| GitHub Pages and deployed smoke | [30188020469](https://github.com/Ronbb/tabulark/actions/runs/30188020469) | success |
| Initial Release workflow | [30188180568](https://github.com/Ronbb/tabulark/actions/runs/30188180568) | failed during MSRV finalization |
| Recovery/finalization | [30188979881](https://github.com/Ronbb/tabulark/actions/runs/30188979881) | success |

The recovery run verified the original tag, CI conclusion, and exact release
inputs. It finalized the already-built assets; it did not run `npm publish`,
`cargo publish`, or create a second GitHub Release.

The formal browser evidence is `Playwright 1.61.1 / Chromium 149.0.7827.55`.
The deployed Pages smoke target is
[`https://ronbb.github.io/tabulark/`](https://ronbb.github.io/tabulark/).

## Registry provenance

Both registries report version `0.1.0` as published from the protected GitHub
trusted-publisher workflow:

- npm: published 2026-07-26T04:51:26.196Z by GitHub Actions; tarball SHA-1
  `290dc84bdb1c6a2dc96538636aae050e82ab74ff`; npm integrity
  `sha512-Z45RTFb37kgaxF3JofRlzcOMhjSmcI9sq/uDJbHZYksV6oior5Me9/Q00CRSrM8/FuL/t2WvNoFeFUzbmuVqrw==`.
- crates.io: checksum
  `e6c0c6f257ca509a5fff53948b9e453bcbc61730142f72fb5480deb14c668d82`;
  trusted-publisher provider `github`, repository `Ronbb/tabulark`, run
  `30188180568`, source SHA
  `f10e40b0c51627676cbcaa87a07d14219db31eb2`.

No local npm token or crates.io login was used. Recovery is an artifact
finalization path only and never republishes a registry version.

## GitHub Release assets

The `v0.1.0` release contains the following assets. Hashes are SHA-256 and are
also recorded in the downloadable `SHA256SUMS` asset.

| Asset | SHA-256 |
| --- | --- |
| `chromium-version.txt` | `16582aa01e638fef8e32364433c7c8d012b7362c8043ce68147a9e3ba390c4fe` |
| `SHA256SUMS` | `507f5157994082d982e37731f3d6321c79e43aa54a9bc27de782556fcee8a2e6` |
| `tabulark-0.1.0.tgz` | `5e761e036d5340e0628ade53e5925f1de15bd6544b977e95b0727cbb18e3f603` |
| `tabulark-0.1.0.crate` | `e6c0c6f257ca509a5fff53948b9e453bcbc61730142f72fb5480deb14c668d82` |
| `tabulark-0.1.0.spdx.json` | `056d9e086b680f6a19af5565e4a14f2c49a7671e203a50cfc474c0e948c39cd4` |

## Follow-on releases

The 0.1.1 line may add compatible JavaScript APIs and presentation/theme
behavior, but it must not alter the `v0.1.0` tag or republish its artifacts.
The M6 large-file work is a separately gated 0.2.0-level change; no new
0.2.0 tag is created until its real-file Chromium and resource-budget gates
have passed.
