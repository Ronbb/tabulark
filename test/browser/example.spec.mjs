import { expect, test } from "@playwright/test";

async function openExample(page) {
  await page.goto("/examples/csv-preview/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("workspace")).toHaveAttribute("aria-busy", "false");
}

async function openParsingOptions(page) {
  const options = page.getByTestId("advanced-options");
  if (await options.getAttribute("open") === null) {
    await options.locator("summary").click();
  }
}

async function expectReady(page) {
  await expect(page.getByTestId("app")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  });
  const grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(page.getByTestId("workspace")).toHaveAttribute("aria-busy", "false");
  return grid;
}

test.describe("CSV preview example", () => {
  test("opens a real local file with advanced parsing options and moves focus to the grid", async ({ page }) => {
    await openExample(page);
    await expect(page.getByTestId("status")).toHaveAttribute("aria-live", "polite");
    await page.evaluate(() => {
      globalThis.__exampleStateHistory = [];
      const app = document.querySelector("[data-testid='app']");
      new MutationObserver(() => {
        globalThis.__exampleStateHistory.push(app.dataset.state);
      }).observe(app, { attributes: true, attributeFilter: ["data-state"] });
    });
    await page.getByTestId("source-input").setInputFiles({
      name: "pipes.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("alpha|beta\none|two\n"),
    });
    await openParsingOptions(page);
    await page.getByTestId("header-mode").selectOption("none");
    await page.getByTestId("parse-mode").selectOption("strict");
    await page.getByTestId("delimiter").fill("|");

    await page.getByTestId("open-button").click();
    const grid = await expectReady(page);

    await expect(page.getByTestId("operation-panel")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("state-label")).toHaveText("Ready");
    await expect(page.getByTestId("file-summary")).toContainText(/pipes\.csv · \d+ B · CSV/);
    await expect(page.locator("[data-tabulark-view]")).toHaveAttribute(
      "aria-label",
      "pipes.csv table preview",
    );
    await expect(grid).toHaveAttribute("aria-label", "pipes.csv table");
    await expect(grid.getByRole("columnheader", { name: "column_1" })).toBeVisible();
    await expect(grid).toContainText("alpha");
    await expect(grid).toContainText("one");
    await expect(grid).toBeFocused();
    await expect.poll(() => page.evaluate(() => globalThis.__exampleStateHistory)).toEqual(
      expect.arrayContaining(["opening", "indexing", "ready"]),
    );
  });

  test("cancels an opening source and retries the same File", async ({ page }) => {
    let delayWorker = true;
    await page.route("**/dist/worker.js", async (route) => {
      if (delayWorker) {
        delayWorker = false;
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      await route.continue();
    });
    await openExample(page);
    await page.getByTestId("source-input").setInputFiles({
      name: "cancel-retry.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("name,value\nfirst,1\nsecond,2\n"),
    });

    await page.getByTestId("open-button").click();
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "opening");
    await expect(page.getByTestId("progress")).toBeVisible();
    await expect(page.getByTestId("advanced-options")).toHaveAttribute("inert", "");
    await expect(page.getByTestId("file-picker")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("cancel-button")).toBeFocused();
    await page.getByTestId("cancel-button").click();

    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "cancelled");
    await expect(page.getByTestId("state-label")).toHaveText("Cancelled");
    await expect(page.getByTestId("workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("progress")).toBeHidden();
    await expect(page.getByTestId("retry-button")).toBeFocused();
    await expect(page.getByTestId("advanced-options")).not.toHaveAttribute("inert", "");
    await expect(page.getByTestId("file-picker")).toHaveAttribute("aria-disabled", "false");

    await page.getByTestId("retry-button").click();
    const grid = await expectReady(page);
    await expect(grid).toContainText("first");
    await expect(page.getByTestId("file-summary")).toContainText("cancel-retry.csv");
  });

  test("recovers from strict parsing failure and keeps lenient warnings visible", async ({ page }) => {
    await openExample(page);
    await page.getByTestId("source-input").setInputFiles({
      name: "ragged.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("left,right\nonly-left\n"),
    });
    await openParsingOptions(page);
    await page.getByTestId("parse-mode").selectOption("strict");

    await page.getByTestId("open-button").click();
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "error", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("status")).toContainText("PARSE_FAILED");
    await expect(page.getByTestId("status")).toBeFocused();
    await expect(page.getByTestId("empty-title")).toHaveText("Preview could not open");

    await page.getByTestId("source-input").setInputFiles({
      name: "different-selection.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("left,right\nnew,selection\n"),
    });
    await page.getByTestId("parse-mode").selectOption("lenient");
    await page.getByTestId("retry-button").click();
    const grid = await expectReady(page);

    await expect(grid).toContainText("only-left");
    await expect(grid).not.toContainText("selection");
    await expect(page.getByTestId("warning-summary")).toBeVisible();
    await expect(page.getByTestId("warning-summary")).toContainText("1 parsing warning");
    await expect(page.getByTestId("status")).toContainText("1 parsing warning was reported");
  });

  test("starts a fresh Worker when retrying after a terminal Worker failure", async ({ page }) => {
    await openExample(page);
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
      const NativeWorker = globalThis.Worker;
      globalThis.__restoreExampleWorker = () => {
        if (descriptor) {
          Object.defineProperty(globalThis, "Worker", descriptor);
        } else {
          delete globalThis.Worker;
        }
      };
      globalThis.__exampleWorkers = [];
      class CapturingWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          globalThis.__exampleWorkers.push(this);
        }
      }
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        writable: true,
        value: CapturingWorker,
      });
    });

    await page.getByTestId("sample-button").click();
    await expectReady(page);
    await expect.poll(() => page.evaluate(() => globalThis.__exampleWorkers.length)).toBe(1);

    await page.evaluate(() => {
      globalThis.__exampleWorkers[0].dispatchEvent(new ErrorEvent("error", {
        message: "synthetic Worker failure",
      }));
    });
    await expect(page.getByTestId("app")).toHaveAttribute("data-state", "error", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("status")).toContainText("RUNTIME_FAILURE");
    await expect(page.getByTestId("status")).toBeFocused();

    await page.getByTestId("retry-button").click();
    const grid = await expectReady(page);
    await expect(grid).toContainText("Record 1");
    await expect.poll(() => page.evaluate(() => globalThis.__exampleWorkers.length)).toBe(2);
    await page.evaluate(() => globalThis.__restoreExampleWorker());
  });

  test("repeatedly replaces local sessions without sending file contents over the network", async ({ page }) => {
    const requests = [];
    const pageErrors = [];
    page.on("request", (request) => {
      requests.push({
        method: request.method(),
        postData: request.postData(),
        url: request.url(),
      });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openExample(page);

    const secrets = ["LOCAL_SECRET_ALPHA", "LOCAL_SECRET_BRAVO", "LOCAL_SECRET_CHARLIE"];
    for (const [index, secret] of secrets.entries()) {
      await page.getByTestId("source-input").setInputFiles({
        name: `private-${index + 1}.csv`,
        mimeType: "text/csv",
        buffer: Buffer.from(`name,value\nrow-${index + 1},${secret}\n`),
      });
      await page.getByTestId("open-button").click();
      const grid = await expectReady(page);
      await expect(grid).toContainText(secret);
      await expect(page.locator("[data-tabulark-view]")).toHaveCount(1);
    }

    expect(pageErrors).toEqual([]);
    const pageOrigin = new URL(page.url()).origin;
    const serializedRequests = JSON.stringify(requests);
    for (const secret of secrets) {
      expect(serializedRequests).not.toContain(secret);
    }
    for (const request of requests) {
      if (request.url.startsWith("http:")) {
        expect(new URL(request.url).origin).toBe(pageOrigin);
      }
      expect(request.method).toBe("GET");
      expect(request.postData).toBeNull();
    }
  });
});
