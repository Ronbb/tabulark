import { basename } from "node:path";

import { expect, test } from "@playwright/test";

const fixturePath = process.env.TABULARK_LARGE_FIXTURE_PATH;
const fixtureFormat = process.env.TABULARK_LARGE_FIXTURE_FORMAT;
const exactSize = Number(process.env.TABULARK_LARGE_EXPECTED_SIZE ?? 2 ** 31);
if (!Number.isSafeInteger(exactSize) || exactSize <= 0 || exactSize > 2 ** 31) {
  throw new Error("TABULARK_LARGE_EXPECTED_SIZE must be a positive safe integer no larger than 2^31");
}

test.skip(
  fixturePath === undefined || fixtureFormat === undefined,
  "The exact 2 GiB gate supplies one generated container at a time.",
);

test.setTimeout(45 * 60 * 1_000);

test("opens one exact 2 GiB local container and reads its final bounded window", async ({ page }) => {
  await page.goto("/target/pages/index.html#playground");
  const input = page.getByTestId("source-input");
  await input.setInputFiles(fixturePath);
  await expect(page.getByTestId("file-summary")).toContainText(
    `${exactSize.toLocaleString("en-US")} bytes`,
  );
  await expect(page.getByTestId("file-summary")).toContainText("2 GiB local-file mode");

  const tail = await input.evaluate(async (element, format) => {
    const file = element.files?.[0];
    if (!file) throw new Error("large fixture was not attached");
    const start = file.size - 64 * 1024;
    const bytes = new Uint8Array(await file.slice(start, file.size).arrayBuffer());
    const ascii = new TextDecoder("latin1").decode(bytes);
    const hex = (part) => [...part].map((value) => value.toString(16).padStart(2, "0")).join("");
    return {
      format,
      lastByteOffset: file.size - 1,
      length: bytes.byteLength,
      prefix: hex(bytes.subarray(0, Math.min(8, bytes.length))),
      suffix: hex(bytes.subarray(Math.max(0, bytes.length - 8))),
      hasCsvMarker: ascii.includes("TABULARK_M6_LAST_BYTE"),
      hasXlsMarker: ascii.endsWith("TABULARK-M6-XLS-TAIL"),
      hasZip64: ascii.includes("PK\u0006\u0006") && ascii.includes("PK\u0006\u0007"),
    };
  }, fixtureFormat);
  expect(tail.length).toBe(64 * 1024);
  expect(tail.lastByteOffset).toBe(exactSize - 1);
  switch (fixtureFormat) {
    case "csv":
      expect(tail.hasCsvMarker).toBe(true);
      break;
    case "arrow":
      expect(tail.suffix.endsWith("4152524f5731")).toBe(true);
      break;
    case "parquet":
      expect(tail.suffix.endsWith("50415231")).toBe(true);
      break;
    case "xlsx":
      expect(tail.hasZip64).toBe(true);
      break;
    case "xls":
      expect(tail.hasXlsMarker).toBe(true);
      break;
    default:
      throw new Error(`unsupported large fixture format ${fixtureFormat}`);
  }

  await page.getByTestId("open-button").click();
  const terminalState = await page.getByTestId("app").evaluate(
    (element) => new Promise((resolve) => {
      const current = element.getAttribute("data-state");
      if (current === "ready" || current === "error") {
        resolve(current);
        return;
      }
      const observer = new MutationObserver(() => {
        const state = element.getAttribute("data-state");
        if (state === "ready" || state === "error") {
          observer.disconnect();
          resolve(state);
        }
      });
      observer.observe(element, { attributes: true, attributeFilter: ["data-state"] });
    }),
    { timeout: 44 * 60 * 1_000 },
  );
  if (terminalState === "error") {
    throw new Error(`large-file open failed: ${await page.getByTestId("status").innerText()}`);
  }
  expect(terminalState).toBe("ready");
  await expect(page.locator("[data-tabulark-a11y-grid]")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("file-summary")).toContainText(basename(fixturePath));
});
