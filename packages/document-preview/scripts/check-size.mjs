import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const budget = JSON.parse(await readFile(resolve(root, "size-budget.json"), "utf8"));
const assets = ["index.js", "pdf-worker.js", "pdfium.wasm"];
let total = 0;
for (const asset of assets) total += (await stat(resolve(root, "dist", asset))).size;
if (total > budget.lazyRuntimeBytes) {
  throw new Error(`Document preview lazy assets use ${total} bytes; budget is ${budget.lazyRuntimeBytes}`);
}
console.log(`Document preview lazy assets: ${total} / ${budget.lazyRuntimeBytes} bytes.`);
