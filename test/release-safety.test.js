import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release tags cannot bypass main, prerequisite runs, or protected environments", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(workflow, /tags:\s*\n\s*- "v\*\.\*\.\*"/u);
  assert.match(workflow, /actions: read/u);
  assert.match(workflow, /git rev-parse "\$\{GITHUB_REF_NAME\}\^\{commit\}"/u);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/u);
  assert.match(
    workflow,
    /for workflow in "CI" "GitHub Pages" "M6 Large Files" "Remote RangeSource"/u,
  );
  assert.match(workflow, /\.head_sha == \$sha/u);
  assert.match(workflow, /\.conclusion == "success"/u);
  assert.match(workflow, /grep -Fx "## \$\{version\}" CHANGELOG\.md/u);
  assert.doesNotMatch(workflow, /\( — unreleased\)\?/u);

  assert.match(workflow, /name: cratesio-release/u);
  assert.match(workflow, /TABULARK_CRATES_TRUSTED_PUBLISHER_CONFIRMED/u);
  assert.match(workflow, /name: npm-release/u);
  assert.match(workflow, /TABULARK_NPM_TRUSTED_PUBLISHER_CONFIRMED/u);
  assert.match(workflow, /needs: \[verify, publish-crate\]/u);
  assert.match(workflow, /needs: \[verify, publish-crate, approve-npm\]/u);
  assert.match(workflow, /needs: \[verify, publish-npm\]/u);
  assert.match(workflow, /registry-crate-smoke:/u);
  assert.match(workflow, /cargo add "tabulark@=\$\{VERSION\}" --features parquet,wasm/u);
  assert.match(workflow, /cargo check --locked/u);
  assert.equal(
    (workflow.match(/--user-agent tabulark-release-workflow/gu) ?? []).length,
    3,
    "every direct crates.io request must send the release workflow user agent",
  );
  assert.match(
    workflow,
    /name: Install Rust 1\.85 MSRV[\s\S]*?toolchain: 1\.85\.0\s*\n\s+targets: wasm32-unknown-unknown/u,
  );

  const approvalJob = workflow.slice(
    workflow.indexOf("  approve-npm:"),
    workflow.indexOf("  publish-npm:"),
  );
  const publishJob = workflow.slice(
    workflow.indexOf("  publish-npm:"),
    workflow.indexOf("  github-release:"),
  );
  assert.match(approvalJob, /environment:\s*\n\s+name: npm-release/u);
  assert.match(approvalJob, /TABULARK_NPM_TRUSTED_PUBLISHER_CONFIRMED/u);
  assert.doesNotMatch(publishJob, /^\s+environment:/mu);
  assert.match(publishJob, /id-token: write/u);
  assert.doesNotMatch(workflow, /^\s+path:\s+target\/release\/\s*$/mu);
  assert.doesNotMatch(workflow, /gh release (?:create|upload)[^\n]*target\/release\/\*/u);
  assert.match(workflow, /target\/release\/browser-versions\.txt/u);
  assert.doesNotMatch(workflow, /target\/release\/chromium-version\.txt/u);
  assert.match(workflow, /sha256sum browser-versions\.txt "\$tarball" \*\.crate \*\.spdx\.json/u);
  assert.match(workflow, /consumer="\$temp_root\/consumer"/u);
});

test("release recovery finalizes immutable artifacts without republishing", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release-recovery.yml", import.meta.url),
    "utf8",
  );

  for (const required of [
    "workflow_dispatch:",
    "source_run_id:",
    "run-id: ${{ inputs.source_run_id }}",
    'source_sha="$(gh api',
    'version="${BASH_REMATCH[1]}"',
    'test "$source_sha" = "$tag_sha"',
    'test "$verify_conclusion" = "success"',
    "sha256sum --check SHA256SUMS",
    'cmp --silent "target/release/tabulark-${VERSION}.tgz"',
    'cmp --silent "target/release/tabulark-${VERSION}.crate"',
    "node: [20, 22, 24]",
    'cargo add "tabulark@=${VERSION}" --features parquet,wasm',
  ]) {
    assert.ok(workflow.includes(required), `recovery workflow must retain ${required}`);
  }
  assert.doesNotMatch(workflow, /(?:npm|cargo) publish/u);
  assert.doesNotMatch(workflow, /gh release (?:create|upload)[^\n]*target\/release\/\*/u);
  assert.match(workflow, /target\/release\/browser-versions\.txt/u);
  assert.doesNotMatch(workflow, /target\/release\/chromium-version\.txt/u);
  assert.ok(
    workflow.indexOf('version="${BASH_REMATCH[1]}"') <
      workflow.indexOf('[[ ! "$SOURCE_RUN_ID" =~ ^[0-9]+$ ]]'),
    "the tag capture must be saved before validating the source run ID",
  );
});

test("pre-tag checks require a finalized clean candidate and external release facts", async () => {
  const preflight = await readFile(
    new URL("../scripts/release-preflight.mjs", import.meta.url),
    "utf8",
  );

  for (const required of [
    "--confirm-npm-trusted-publisher",
    "--confirm-crates-trusted-publisher",
    "status",
    "ls-remote",
    "refs/heads/main",
    "refs/tags/${requestedTag}",
    "registry.npmjs.org",
    "crates.io/api/v1/crates",
    "collaborators",
    "owners",
    'assertSuccessfulWorkflow("CI", head)',
    'assertSuccessfulWorkflow("GitHub Pages", head)',
    'assertSuccessfulWorkflow("M6 Large Files", head)',
    'assertSuccessfulWorkflow("Remote RangeSource", head)',
    "GH_TOKEN",
  ]) {
    assert.ok(preflight.includes(required), `preflight must retain ${required}`);
  }
  assert.match(preflight, /\^## \$\{escapeRegExp\(cargoVersion\)\}\$/u);
  assert.match(preflight, /has \*\*not\*\* been published/u);
  assert.doesNotMatch(preflight, /\(\?: — unreleased\)\?/u);
});

test("Remote RangeSource gate covers contracts, package size, and all desktop browsers", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/range-sources.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^name: Remote RangeSource$/mu);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run typecheck/u);
  assert.match(workflow, /npm run package:check/u);
  assert.match(workflow, /npm run benchmark:size/u);
  assert.match(workflow, /playwright install --with-deps chromium firefox webkit/u);
  assert.match(workflow, /test\/browser\/remote-range-source\.spec\.mjs/u);
  for (const project of ["chromium", "firefox", "webkit"]) {
    assert.match(workflow, new RegExp(`--project=${project}`, "u"));
  }
  assert.match(workflow, /--workers=1 --retries=0/u);
});

test("M6 generates and deletes five exact 2 GiB containers without artifacting fixtures", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/large-files.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^name: M6 Large Files$/mu);
  assert.match(workflow, /timeout-minutes: 240/u);
  assert.match(workflow, /for format in csv arrow parquet xlsx xls; do/u);
  assert.match(workflow, /available_kib < 4 \* 1024 \* 1024/u);
  assert.match(workflow, /--size 2147483648/u);
  assert.match(workflow, /test "\$apparent" -eq 2147483648/u);
  assert.match(workflow, /timeout --signal=TERM 45m/u);
  assert.match(workflow, /--project=chromium --workers=1 --retries=0/u);
  assert.match(workflow, /rm -f -- "\$fixture"/u);
  assert.doesNotMatch(workflow, /path:[^\n]*tabulark-m6-/u);
  assert.match(workflow, /target\/m6-generator\/tabulark-large-fixture-generator/u);
  assert.doesNotMatch(workflow, /tools\/large-fixture-generator\/target\/$/mu);
});
