# 0.2.0 delivery and release policy

The 0.2.0 release candidate is finalized. Version 0.1.1 was never tagged or
published; do not create a `v0.1.1` tag. The completed 0.1.0 tag target,
protected runs, registry provenance, and checksums remain frozen in
[`release-0.1.0-evidence.md`](release-0.1.0-evidence.md). `v0.1.0` is
immutable: never move, force-update, or rebuild it.

## Pre-tag checklist

For 0.2.0, start from a clean checkout whose `HEAD` equals `origin/main`. Run
the full format, type, Rust, packed-consumer, fuzz-seed, three-browser,
Chromium performance/size, and exact-large-file matrix documented in
[`testing.md`](testing.md). Confirm that `CI`, `GitHub Pages`, and `M6 Large
Files` all completed successfully for that same `HEAD`, then run:

```sh
node scripts/release-preflight.mjs v0.2.0 \
  --confirm-npm-trusted-publisher \
  --confirm-crates-trusted-publisher
```

The preflight blocks tagging unless all of these conditions hold:

- `package.json`, `Cargo.toml`, and `CHANGELOG.md` agree on the version.
- The release heading no longer says `unreleased`, and the changelog no longer
  claims that the version has not been published.
- The worktree is clean, `HEAD` equals `origin/main`, and the tag is unused
  both locally and remotely.
- npm and crates.io do not already contain that version; expected registry
  owners are still present.
- The operator explicitly confirms the npm and crates.io OIDC trusted-publisher
  configuration. This cannot be inferred safely through a public registry API.
- `CI`, `GitHub Pages`, and `M6 Large Files` are all successful for the exact
  same commit, and the deployed Pages URL is reachable.
- The three-browser and exact-large-file evidence used zero retries. A test
  that passed only after retry is diagnostic information, not release
  evidence.

The tag-triggered workflow independently repeats the `origin/main` and exact
same-SHA CI/Pages/M6 checks. A tag cannot bypass a skipped local preflight.
Only after the preflight succeeds should the immutable release tag be created
and pushed:

```sh
git tag -a v0.2.0 -m "tabulark 0.2.0"
git push origin v0.2.0
```

The confirmation flags are deliberate: before tagging, independently verify
that npm's trusted publisher is restricted to this repository/workflow and that
crates.io is configured for the same release identity. In the release workflow,
the protected GitHub Environments repeat that check through reviewer approval
and environment-scoped confirmation variables.

## Tag-triggered release order

Pushing `vX.Y.Z` starts the release workflow. It first reruns verification,
creates and checks the npm tarball, records its SHA-256, and validates package
contents. Publishing is then serialized:

1. `publish-crate` waits for the protected `cratesio-release` Environment.
   It checks registry availability again and uses the crates.io OIDC trusted
   publisher.
2. `approve-npm` waits for the protected `npm-release` Environment and for the
   crate job. After approval, `publish-npm` uses the established repository and
   `release.yml` OIDC identity (without a GitHub Environment claim) to publish
   the verified tarball with npm provenance rather than rebuilding a different
   archive.
3. `github-release` waits for npm. It attaches the recorded tarball checksum
   and SPDX SBOM to the GitHub Release.
4. `registry-smoke` installs the published npm package into a clean consumer,
   imports all stable entry points, typechecks a consumer, and verifies the
   exact registry version.
5. `registry-crate-smoke` resolves the exact crates.io version in a clean Cargo
   project, enables the published experimental feature set, then compiles and
   runs that consumer.

Repository administrators must configure both named Environments with required
reviewers before enabling release tags. The workflow intentionally fails if
the environment has not supplied
`TABULARK_NPM_TRUSTED_PUBLISHER_CONFIRMED=1` or
`TABULARK_CRATES_TRUSTED_PUBLISHER_CONFIRMED=1`. Registry publication uses
GitHub OIDC trusted publishers; local credentials, long-lived npm tokens, and
long-lived crates.io tokens are not release paths.

The npm Environment is deliberately an approval-only gate. The downstream
publisher job has no Environment so its OIDC identity continues to match the
trusted publisher established by the successful 0.0.x releases. No local npm
login or long-lived npm token participates in publication.

## Immutable release semantics

Registry publication is not atomically reversible. A tag may be rerun without
code changes when a workflow delivery step fails. Before a rerun accepts an
existing version, it downloads the registry `.crate` or npm tarball and
compares it byte-for-byte with the checksum-verified release bundle; a
mismatch fails the workflow instead of silently skipping publication. If code
needs to change after either registry publishes 0.2.0, create a new immutable
patch release such as `v0.2.1`; never create the skipped `v0.1.1`, and never
move or reuse `v0.1.0` or `v0.2.0`.

If both registries already match the verified bundle but GitHub Release
finalization or the downstream consumer jobs fail, do not move the tag. Run
the `Release Recovery` workflow with the immutable tag and the original
Release run ID. The recovery workflow verifies that the source run SHA equals
the tag, checks the bundle and both registry artifacts byte-for-byte, repairs
the GitHub Release using only the five expected top-level files, and reruns the
Node 20/22/24 and Cargo registry consumers. The successful recovery run is the
finalization evidence; it never republishes either registry package.

## Evidence history

The previous milestone's CI, Pages deployment, and deployed-URL smoke evidence
is recorded in [`m4-completion.md`](m4-completion.md). The completed 0.1.0
artifact evidence is in [`release-0.1.0-evidence.md`](release-0.1.0-evidence.md).
