import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release tags cannot bypass main, prerequisite runs, or protected environments", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(workflow, /tags:\s*\n\s*- "v\*\.\*\.\*"/u);
  assert.match(workflow, /actions: read/u);
  assert.match(workflow, /git rev-parse "\$\{GITHUB_REF_NAME\}\^\{commit\}"/u);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/u);
  assert.match(workflow, /for workflow in "CI" "GitHub Pages"/u);
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
    "GH_TOKEN",
  ]) {
    assert.ok(preflight.includes(required), `preflight must retain ${required}`);
  }
  assert.match(preflight, /\^## \$\{escapeRegExp\(cargoVersion\)\}\$/u);
  assert.match(preflight, /has \*\*not\*\* been published/u);
  assert.doesNotMatch(preflight, /\(\?: — unreleased\)\?/u);
});
