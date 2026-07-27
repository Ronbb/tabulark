import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const target = resolve(root, "target");
const output = resolve(target, "document-preview-pages");
if (output === target || !output.startsWith(`${target}${sep}`)) throw new Error("Unsafe document preview output path");

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("Run this builder through npm so its pinned CLI can be reused");
const built = spawnSync(process.execPath, [npmCli, "run", "build", "--prefix", "packages/document-preview"], { cwd: root, stdio: "inherit" });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "examples"), { recursive: true });
await mkdir(resolve(output, "packages", "document-preview"), { recursive: true });
await Promise.all([
  cp(resolve(root, "examples", "document-preview"), resolve(output, "examples", "document-preview"), { recursive: true }),
  cp(resolve(root, "packages", "document-preview", "dist"), resolve(output, "packages", "document-preview", "dist"), { recursive: true }),
  cp(resolve(root, "packages", "document-preview", "LICENSE-MIT"), resolve(output, "LICENSE-MIT")),
  cp(resolve(root, "packages", "document-preview", "THIRD_PARTY_NOTICES.md"), resolve(output, "THIRD_PARTY_NOTICES.md")),
  writeFile(resolve(output, ".nojekyll"), "", "utf8"),
  writeFile(resolve(output, "index.html"), '<!doctype html><meta http-equiv="refresh" content="0;url=./examples/document-preview/">', "utf8"),
]);
console.log("Prepared target/document-preview-pages without modifying stable Pages output.");
