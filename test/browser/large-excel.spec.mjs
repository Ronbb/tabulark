import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

test("large-mode XLSX uses bounded range reads through the Rust/WASM Excel adapter", async ({ page }) => {
  const wasmRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("tabulark_excel")) wasmRequests.push(request.url());
  });
  await page.goto("/test/browser/harness.html");
  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const { excelAdapter } = await import("/dist/excel.js");
    const response = await fetch("/test/fixtures/excel/v1/tabulark-ooxml.xlsx");
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    const source = new File([await response.blob()], "large-mode.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const engine = await createEngine({
      adapters: [excelAdapter],
      memoryBudgetBytes: 64 * 1024 * 1024,
    });
    const dataset = await engine.open(source, {
      adapter: excelAdapter,
      sourceMode: "large",
      adapterOptions: { format: "xlsx", sourceName: source.name },
    });
    const table = await dataset.openTable(dataset.tables[0].id);
    const batch = await table.readRange({
      rowStart: 0,
      rowCount: 4,
      columnStart: 0,
      columnCount: 4,
    });
    const presentation = await table.getPresentation();
    const presentationRange = await table.readPresentationRange({
      rowStart: 0,
      rowCount: 4,
      columnStart: 0,
      columnCount: 4,
    });
    const rows = batch.toDisplayRows();
    const capabilities = dataset.getCapabilities();
    await table.close();
    await dataset.close();
    await engine.close();
    return {
      rows,
      presentationKind: presentation?.kind,
      presentation: presentation === null ? null : {
        frozenRows: presentation.frozenRows,
        frozenColumns: presentation.frozenColumns,
        styles: presentation.styles.length,
        mergedCells: presentationRange?.mergedCells.length,
      },
      sourceBytes: source.size,
      capabilities,
    };
  });
  expect(result.presentationKind).toBe("spreadsheet-v1");
  expect(result.presentation).toEqual({ frozenRows: 1, frozenColumns: 1, styles: 3, mergedCells: 1 });
  expect(result.rows.flat()).toContain("上海");
  expect(result.sourceBytes).toBeGreaterThan(0);
  expect(result.capabilities.sourceAccess).toBe("range");
  expect(result.capabilities.maxSourceBytes).toBe(2 * 1024 * 1024 * 1024);
  expect(wasmRequests.length).toBeGreaterThan(0);
});

test("large-mode XLSX accepts a ZIP64 central-directory envelope", async ({ page }) => {
  await page.goto("/test/browser/harness.html");
  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const { excelAdapter } = await import("/dist/excel.js");
    const response = await fetch("/test/fixtures/excel/v1/tabulark-ooxml.xlsx");
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    const original = new Uint8Array(await response.arrayBuffer());
    const eocdSignature = 0x0605_4b50;
    const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
    let eocdOffset = -1;
    for (let offset = original.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === eocdSignature) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("fixture EOCD is missing");
    const centralSize = view.getUint32(eocdOffset + 12, true);
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    const writeU64 = (target, offset, value) => {
      target.setUint32(offset, value >>> 0, true);
      target.setUint32(offset + 4, Math.floor(value / 0x1_0000_0000) >>> 0, true);
    };
    const zip64 = new Uint8Array(56);
    const zip64View = new DataView(zip64.buffer);
    zip64View.setUint32(0, 0x0606_4b50, true);
    writeU64(zip64View, 4, 44);
    zip64View.setUint16(12, 45, true);
    zip64View.setUint16(14, 45, true);
    writeU64(zip64View, 24, entryCount);
    writeU64(zip64View, 32, entryCount);
    writeU64(zip64View, 40, centralSize);
    writeU64(zip64View, 48, centralOffset);
    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    locatorView.setUint32(0, 0x0706_4b50, true);
    writeU64(locatorView, 8, eocdOffset);
    locatorView.setUint32(16, 1, true);
    const legacy = original.slice(eocdOffset);
    const legacyView = new DataView(legacy.buffer);
    legacyView.setUint16(8, 0xffff, true);
    legacyView.setUint16(10, 0xffff, true);
    legacyView.setUint32(12, 0xffff_ffff, true);
    legacyView.setUint32(16, 0xffff_ffff, true);
    const wrapped = new Uint8Array(eocdOffset + zip64.byteLength + locator.byteLength + legacy.byteLength);
    wrapped.set(original.subarray(0, eocdOffset), 0);
    wrapped.set(zip64, eocdOffset);
    wrapped.set(locator, eocdOffset + zip64.byteLength);
    wrapped.set(legacy, eocdOffset + zip64.byteLength + locator.byteLength);
    const source = new File([wrapped], "zip64.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const engine = await createEngine({ adapters: [excelAdapter], memoryBudgetBytes: 64 * 1024 * 1024 });
    const dataset = await engine.open(source, {
      adapter: excelAdapter,
      sourceMode: "large",
      adapterOptions: { format: "xlsx" },
    });
    const table = await dataset.openTable(dataset.tables[0].id);
    const rows = (await table.readRange({
      rowStart: 0,
      rowCount: 1,
      columnStart: 0,
      columnCount: 1,
    })).toDisplayRows();
    await table.close();
    await dataset.close();
    await engine.close();
    return rows;
  });
  expect(result).toEqual([["城市数据"]]);
});

test("large-mode XLSX ignores an EOCD signature embedded in the ZIP comment", async ({ page }) => {
  await page.goto("/test/browser/harness.html");
  const result = await page.evaluate(async () => {
    const { createEngine } = await import("/dist/index.js");
    const { excelAdapter } = await import("/dist/excel.js");
    const response = await fetch("/test/fixtures/excel/v1/tabulark-ooxml.xlsx");
    if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
    const original = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
    let eocdOffset = -1;
    for (let offset = original.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x0605_4b50) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("fixture EOCD is missing");
    const comment = new Uint8Array(30);
    new DataView(comment.buffer).setUint32(0, 0x0605_4b50, true);
    const wrapped = new Uint8Array(original.byteLength + comment.byteLength);
    wrapped.set(original);
    wrapped.set(comment, original.byteLength);
    new DataView(wrapped.buffer).setUint16(eocdOffset + 20, comment.byteLength, true);

    const source = new File([wrapped], "comment-signature.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const engine = await createEngine({ adapters: [excelAdapter], memoryBudgetBytes: 64 * 1024 * 1024 });
    const dataset = await engine.open(source, {
      adapter: excelAdapter,
      sourceMode: "large",
      adapterOptions: { format: "xlsx" },
    });
    const table = await dataset.openTable(dataset.tables[0].id);
    const rows = (await table.readRange({
      rowStart: 0,
      rowCount: 1,
      columnStart: 0,
      columnCount: 1,
    })).toDisplayRows();
    await table.close();
    await dataset.close();
    await engine.close();
    return rows;
  });
  expect(result).toEqual([["城市数据"]]);
});
