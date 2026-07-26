import "/dist/worker.js";

globalThis.__tabularkTestOnlyAdapterModuleUrls = {
  "tabulark:excel": new URL("./excel-presentation-budget-adapter.mjs", import.meta.url).href,
};
