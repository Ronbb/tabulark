/**
 * Installs the cross-browser clipboard contract used by functional tests.
 * Chromium deliberately exercises the real permission-gated Clipboard API.
 * Firefox and WebKit use a deterministic navigator seam because their
 * headless permission implementations differ from a desktop page.
 */
export async function installClipboardContract({ browserName, context, page }) {
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    return;
  }
  await page.addInitScript(() => {
    let captured = "";
    const clipboard = Object.freeze({
      async readText() {
        return captured;
      },
      async writeText(text) {
        captured = String(text);
      },
    });
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => clipboard,
    });
  });
}

export async function readClipboardText(page) {
  return (await page.evaluate(() => navigator.clipboard.readText()))
    .replaceAll("\r\n", "\n");
}
