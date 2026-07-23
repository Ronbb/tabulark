# Releasing Tabulark

Tabulark publishes the same version number to crates.io and npm. The release
workflow validates that `Cargo.toml`, `package.json`, and the Git tag agree.

## Bootstrap the package names

Trusted Publishing can only be configured after the package names have an
initial owner. Publish the first version manually from a trusted workstation:

```bash
cargo login
npm login

cargo publish --locked
npm publish
```

The initial `0.0.1` release is an installable, explicitly pre-alpha scaffold. It
establishes package ownership while validating package contents and the release
chain. Run the complete verification suite locally before publishing it.

## Configure Trusted Publishing

After the first release, configure both registries to trust the GitHub Actions
workflow instead of storing long-lived publishing tokens.

Use these values on npm:

- Organization or user: `Ronbb`
- Repository: `tabulark`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

Use the equivalent GitHub Trusted Publisher settings on crates.io for the
`tabulark` crate and `.github/workflows/release.yml`.

The committed workflow requests `id-token: write`, uses GitHub-hosted runners,
and obtains short-lived credentials from each registry. No npm or crates.io
publishing secret is required after bootstrap.

## Publish a release

1. Update the version in both `Cargo.toml` and `package.json`.
2. Update release notes when a changelog is introduced.
3. Run the full local verification suite.
4. Commit the version change.
5. Create and push the matching tag.

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo package --allow-dirty --locked
npm ci
npm run check

git tag -a v0.0.2 -m "v0.0.2"
git push origin main --follow-tags
```

The initial workflow accepts stable `vX.Y.Z` tags only. It deliberately rejects
pre-release versions until the project defines a separate npm dist-tag policy.

Pushing a tag shaped like `vX.Y.Z` starts `.github/workflows/release.yml`. The
workflow re-runs validation and publishes any registry version that does not
already exist, which makes rerunning an interrupted release safe.

## Recommended repository protection

- Protect version tags from unreviewed creation.
- Require the CI workflow before merging to `main`.
- Optionally attach the release jobs to a protected GitHub environment.
- After validating Trusted Publishing, require it exclusively in each registry.
