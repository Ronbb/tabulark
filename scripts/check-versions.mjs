import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const cargoToml = await readFile(new URL("Cargo.toml", root), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (!cargoVersion) {
  throw new Error("Could not find the package version in Cargo.toml");
}

if (packageJson.version !== cargoVersion) {
  throw new Error(
    `Version mismatch: package.json=${packageJson.version}, Cargo.toml=${cargoVersion}`,
  );
}

const releaseVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (!releaseVersion.test(cargoVersion)) {
  throw new Error(`Unsupported release version: ${cargoVersion}`);
}

const tag = process.argv[2];
if (tag && tag !== `v${cargoVersion}`) {
  throw new Error(`Tag ${tag} does not match package version v${cargoVersion}`);
}

process.stdout.write(`${cargoVersion}\n`);
