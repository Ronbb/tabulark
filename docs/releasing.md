# Delivery and release policy

M4 completed as a source and Pages milestone. It did **not** publish 0.1.0.
The 0.1.0 tag remains the only formal release entry point, and it must not be
created until this checklist is complete.

## Pre-tag checklist

From a clean checkout at `origin/main`, run the full format, type, Rust,
package-consumer, Chromium, fuzz-seed, and size matrix documented in
[`testing.md`](testing.md). Then run:

```sh
node scripts/release-preflight.mjs v0.1.0 \
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
- CI and GitHub Pages are both successful for the exact commit, and the
  deployed Pages URL is reachable.

The tag-triggered workflow independently repeats the `origin/main` and exact
CI/Pages-run checks. A tag cannot bypass a skipped local preflight.

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
2. `publish-npm` waits for the protected `npm-release` Environment and for the
   crate job. It publishes the verified tarball with npm provenance rather than
   rebuilding a different archive.
3. `github-release` waits for npm. It attaches the recorded tarball checksum
   and SPDX SBOM to the GitHub Release.
4. `registry-smoke` installs the published npm package into a clean consumer,
   imports all stable entry points, typechecks a consumer, and verifies the
   exact registry version.
5. `registry-crate-smoke` resolves the exact crates.io version in a clean Cargo
   project, enables the published experimental feature set, then compiles and
   runs that consumer.

Repository administrators must configure both named Environments with required
reviewers before enabling release tags. The workflow intentionally fails if the
environment has not supplied `TABULARK_NPM_TRUSTED_PUBLISHER_CONFIRMED=1` or
`TABULARK_CRATES_TRUSTED_PUBLISHER_CONFIRMED=1`.

## Immutable release semantics

Registry publication is not atomically reversible. A tag may be rerun without
code changes when a workflow delivery step fails. Before a rerun accepts an
existing version, it downloads the registry `.crate` or npm tarball and compares
it byte-for-byte with the checksum-verified release bundle; a mismatch fails
the workflow instead of silently skipping publication. If code needs to change
after either registry publishes, create a new patch release such as `0.1.1`;
deprecate and/or yank `0.1.0` according to severity rather than moving or
reusing its tag.

## M4 evidence

The previous milestone's CI, Pages deployment, and deployed-URL smoke evidence
is recorded in [`m4-completion.md`](m4-completion.md). That record does not
substitute for the 0.1.0 format-specific release gates.
