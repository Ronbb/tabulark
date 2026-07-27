import { expect, test } from "@playwright/test";

test("PDFium Worker opens and renders an offline local PDF", async ({ page }) => {
  const consoleErrors = [];
  const requests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/examples/document-preview/");
  await page.getByLabel("Choose PDF").setInputFiles({
    name: "sample.pdf",
    mimeType: "application/pdf",
    buffer: makePdf(),
  });
  await expect(page.locator("#status")).toContainText("sample.pdf: 1 page", { timeout: 15_000 });
  const preview = page.getByRole("group", { name: "Document pages" });
  await expect(preview).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous page" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fit width" })).toBeVisible();
  await expect.poll(() => page.locator(".tdp-page canvas").evaluate((canvas) => ({ width: canvas.width, height: canvas.height }))).toMatchObject({
    width: expect.any(Number),
    height: expect.any(Number),
  });
  const dimensions = await page.locator(".tdp-page canvas").evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  expect(dimensions.width).toBeGreaterThan(100);
  expect(dimensions.height).toBeGreaterThan(100);
  await preview.focus();
  await preview.press("0");
  await expect(page.getByLabel("Zoom level")).toHaveText("100%");
  expect(consoleErrors).toEqual([]);
  expect(requests.every((url) => new URL(url).origin === "http://127.0.0.1:4183")).toBe(true);
  expect(requests.some((url) => /docx|rwml|betteroffice/iu.test(url))).toBe(false);
});

function makePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("BT /F1 24 Tf 50 330 Td (Tabulark PDF) Tj ET"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let length = chunks[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, "binary");
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const rows = offsets.map((offset, index) => index === 0
    ? "0000000000 65535 f \n"
    : `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n${rows}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "binary"));
  return Buffer.concat(chunks);
}

function stream(content) {
  return `<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}\nendstream`;
}
