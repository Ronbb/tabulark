#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const repository = "Ronbb/tabulark";
const npmPackage = "tabulark";
const crate = "tabulark";
const expectedNpmOwner = process.env.TABULARK_NPM_OWNER ?? "ronbb";
const expectedCratesOwner = process.env.TABULARK_CRATES_OWNER ?? "Ronbb";

const requestedTag = process.argv.find((argument) => /^v\d+\.\d+\.\d+$/u.test(argument));
if (!requestedTag) {
  throw new Error(
    "Usage: node scripts/release-preflight.mjs vX.Y.Z "
      + "--confirm-npm-trusted-publisher --confirm-crates-trusted-publisher",
  );
}

requireConfirmation(
  "--confirm-npm-trusted-publisher",
  "TABULARK_NPM_TRUSTED_PUBLISHER_CONFIRMED",
  "npm trusted publisher configuration has not been confirmed",
);
requireConfirmation(
  "--confirm-crates-trusted-publisher",
  "TABULARK_CRATES_TRUSTED_PUBLISHER_CONFIRMED",
  "crates.io trusted publisher configuration has not been confirmed",
);

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const cargoToml = await readFile(new URL("../Cargo.toml", import.meta.url), "utf8");
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
if (!cargoVersion || packageJson.version !== cargoVersion) {
  throw new Error("package.json and Cargo.toml versions are not synchronized");
}
const expectedTag = `v${cargoVersion}`;
if (requestedTag !== expectedTag) {
  throw new Error(`Requested tag ${requestedTag} does not match ${expectedTag}`);
}
if (!new RegExp(`^## ${escapeRegExp(cargoVersion)}$`, "mu").test(changelog)) {
  throw new Error(`CHANGELOG.md has not been finalized for ${cargoVersion}`);
}
if (changelog.includes("has **not** been published")) {
  throw new Error("CHANGELOG.md still describes the release as unpublished");
}

const status = git(["status", "--porcelain"]);
if (status.trim() !== "") {
  throw new Error("The worktree must be clean before release preflight");
}
const head = git(["rev-parse", "HEAD"]).trim();
const remoteMain = git(["ls-remote", "origin", "refs/heads/main"])
  .trim()
  .split(/\s+/u)[0];
if (!remoteMain || head !== remoteMain) {
  throw new Error(`HEAD ${head} is not remote main ${remoteMain ?? "<missing>"}`);
}
if (git(["tag", "--list", requestedTag]).trim() !== "") {
  throw new Error(`Local tag ${requestedTag} already exists`);
}
if (git(["ls-remote", "--tags", "origin", `refs/tags/${requestedTag}`]).trim() !== "") {
  throw new Error(`Remote tag ${requestedTag} already exists`);
}

await assertVersionAbsent(
  `https://registry.npmjs.org/${npmPackage}/${cargoVersion}`,
  `npm ${npmPackage}@${cargoVersion}`,
);
await assertVersionAbsent(
  `https://crates.io/api/v1/crates/${crate}/${cargoVersion}`,
  `crates.io ${crate} ${cargoVersion}`,
);
await assertNpmOwner();
await assertCratesOwner();
await assertSuccessfulWorkflow("CI", head);
await assertSuccessfulWorkflow("GitHub Pages", head);
await assertSuccessfulWorkflow("M6 Large Files", head);

const deployed = await fetch("https://ronbb.github.io/tabulark/", {
  headers: { "user-agent": "tabulark-release-preflight" },
  redirect: "follow",
});
if (!deployed.ok) {
  throw new Error(`Deployed Pages URL returned HTTP ${deployed.status}`);
}

console.log(`Release preflight passed for ${requestedTag} at ${head}.`);
console.log("Registry versions are unused, owners are correct, trusted publishers were confirmed, and CI/Pages/M6 are green for one SHA.");

function requireConfirmation(flag, environmentName, message) {
  if (!process.argv.includes(flag) && process.env[environmentName] !== "1") {
    throw new Error(message);
  }
}

async function assertVersionAbsent(url, label) {
  const response = await fetch(url, {
    headers: { "user-agent": "tabulark-release-preflight" },
    redirect: "follow",
  });
  if (response.status === 404) return;
  if (response.ok) throw new Error(`${label} already exists`);
  throw new Error(`Could not verify ${label}: HTTP ${response.status}`);
}

async function assertNpmOwner() {
  const response = await fetch(`https://registry.npmjs.org/-/package/${npmPackage}/collaborators`, {
    headers: { "user-agent": "tabulark-release-preflight" },
  });
  if (!response.ok) {
    throw new Error(`Could not verify npm ownership: HTTP ${response.status}`);
  }
  const owners = await response.json();
  if (!Object.hasOwn(owners, expectedNpmOwner)) {
    throw new Error(`npm owner ${expectedNpmOwner} is not listed for ${npmPackage}`);
  }
}

async function assertCratesOwner() {
  const response = await fetch(`https://crates.io/api/v1/crates/${crate}/owners`, {
    headers: { "user-agent": "tabulark-release-preflight" },
  });
  if (!response.ok) {
    throw new Error(`Could not verify crates.io ownership: HTTP ${response.status}`);
  }
  const result = await response.json();
  const owners = Array.isArray(result.users) ? result.users : [];
  if (!owners.some((owner) => owner?.login === expectedCratesOwner)) {
    throw new Error(`crates.io owner ${expectedCratesOwner} is not listed for ${crate}`);
  }
}

async function assertSuccessfulWorkflow(name, sha) {
  const githubToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
        "user-agent": "tabulark-release-preflight",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Could not verify ${name}: HTTP ${response.status}`);
  }
  const result = await response.json();
  const run = result.workflow_runs?.find((candidate) => (
    candidate.name === name
      && candidate.head_sha === sha
      && candidate.status === "completed"
      && candidate.conclusion === "success"
  ));
  if (!run) {
    throw new Error(`${name} has no successful completed run for ${sha}`);
  }
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`git ${args.join(" ")} exited with status ${String(result.status)}`);
  }
  return result.stdout ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
