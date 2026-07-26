import { expect, test } from "@playwright/test";

async function openSample(page) {
  await page.goto("/examples/csv-preview/");
  await page.getByRole("button", { name: "Try CSV sample" }).click();

  const view = page.locator("[data-tabulark-view]");
  const grid = page.locator("[data-tabulark-a11y-grid]");
  await expect(view).toBeVisible({ timeout: 15_000 });
  await expect(grid).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(grid).toContainText("Record 1");
  return { view, grid };
}

test.describe("Canvas table view", () => {
  test("renders a visual Canvas with a bounded semantic viewport", async ({ page }) => {
    const { view, grid } = await openSample(page);
    await expect(view).toHaveAttribute("data-tabulark-color-scheme", "light");
    const canvas = view.locator("canvas.tabulark-canvas");

    await expect(canvas).toHaveAttribute("aria-hidden", "true");
    await expect(grid).toHaveAttribute("role", "grid");
    await expect(grid).toHaveAttribute("aria-colcount", "6");
    await expect(grid).toHaveAttribute("aria-rowcount", "2001");

    const canvasSize = await canvas.evaluate((element) => ({
      cssWidth: element.getBoundingClientRect().width,
      cssHeight: element.getBoundingClientRect().height,
      pixelWidth: element.width,
      pixelHeight: element.height,
    }));
    expect(canvasSize.cssWidth).toBeGreaterThan(600);
    expect(canvasSize.cssHeight).toBeGreaterThan(300);
    expect(canvasSize.pixelWidth).toBeGreaterThanOrEqual(canvasSize.cssWidth);
    expect(canvasSize.pixelHeight).toBeGreaterThanOrEqual(canvasSize.cssHeight);

    // The semantic tree represents only visible/overscan cells, never all 2,000 rows.
    expect(await grid.locator('[role="row"]').count()).toBeLessThan(100);
    expect(await grid.locator('[role="gridcell"]').count()).toBeLessThan(600);
  });

  test("keeps the Playground Canvas and page palette in sync while auto-switching", async ({
    page,
  }) => {
    let paintCount = 0;
    await page.addInitScript(() => {
      const prototype = CanvasRenderingContext2D.prototype;
      const original = prototype.clearRect;
      prototype.clearRect = function (...args) {
        if (this.canvas?.matches?.("[data-tabulark-canvas]")) {
          globalThis.__tabularkThemePaintCount =
            (globalThis.__tabularkThemePaintCount ?? 0) + 1;
        }
        return original.apply(this, args);
      };
    });
    await page.emulateMedia({ colorScheme: "dark", forcedColors: "none" });
    const opened = await openSample(page);
    const view = opened.view;
    await expect(view).toHaveAttribute("data-tabulark-color-scheme", "dark");
    await expect.poll(() => page.evaluate(() => (
      globalThis.__tabularkThemePaintCount ?? 0
    ))).toBeGreaterThan(0);
    const darkSurface = await view.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
    }));
    expect(darkSurface.background).toBe("rgb(24, 34, 53)");
    expect(darkSurface.color).toBe("rgb(237, 240, 247)");
    const beforeSwitch = await page.evaluate(() => globalThis.__tabularkThemePaintCount ?? 0);

    await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
    await expect(view).toHaveAttribute("data-tabulark-color-scheme", "light");
    await expect.poll(() => page.evaluate(() => (
      globalThis.__tabularkThemePaintCount ?? 0
    ))).toBeGreaterThan(beforeSwitch);
    const lightSurface = await view.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
    }));
    expect(lightSurface.background).toBe("rgb(255, 255, 255)");
    expect(lightSurface.color).toBe("rgb(23, 32, 51)");
  });

  test("keeps the compatibility default light and supports an explicit dark palette", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark", forcedColors: "none" });
    await page.goto("/test/browser/harness.html");
    const result = await page.evaluate(async () => {
      const { createCanvasTableView, createEngine, delimitedAdapter } = await import("/dist/index.js");
      const host = document.createElement("div");
      const darkHost = document.createElement("div");
      Object.assign(host.style, { height: "240px", width: "440px" });
      Object.assign(darkHost.style, { height: "240px", width: "440px" });
      document.body.replaceChildren(host, darkHost);

      const engine = await createEngine({ adapters: [delimitedAdapter] });
      const dataset = await engine.open(new Blob(["name,value\nalpha,1\nbeta,2\n"]), {
        adapter: delimitedAdapter,
        adapterOptions: { dialect: "csv", header: "first-row", mode: "strict" },
      });
      const table = await dataset.openTable(dataset.tables[0].id);
      const compatibilityView = createCanvasTableView({
        container: host,
        presentation: "ignore",
        table,
      });
      const explicitDarkView = createCanvasTableView({
        colorScheme: "dark",
        container: darkHost,
        presentation: "ignore",
        table,
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const readSurface = (element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        scheme: element.dataset.tabularkColorScheme,
      });
      const output = {
        compatibility: readSurface(compatibilityView.element),
        explicitDark: readSurface(explicitDarkView.element),
      };
      explicitDarkView.destroy();
      compatibilityView.destroy();
      await table.close();
      await dataset.close();
      await engine.close();
      return output;
    });

    expect(result.compatibility).toEqual({
      background: "rgb(255, 255, 255)",
      color: "rgb(23, 32, 51)",
      scheme: "light",
    });
    expect(result.explicitDark).toEqual({
      background: "rgb(24, 34, 53)",
      color: "rgb(237, 240, 247)",
      scheme: "dark",
    });
  });

  test("supports keyboard range selection and copy as TSV", async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { grid } = await openSample(page);

    await grid.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");

    await expect(grid).toHaveAttribute(
      "aria-activedescendant",
      /-r1-c1$/,
    );
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(2);

    await page.keyboard.press("Control+C");
    await expect
      .poll(async () =>
        (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n"),
      )
      .toBe("Record 1\nRecord 2");

    await page.keyboard.press("Escape");
    await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(0);
    await expect(grid).toHaveAttribute("aria-activedescendant", /-r1-c1$/);
  });

  test("resizes columns by keyboard while preserving separator focus", async ({ page }) => {
    const { view, grid } = await openSample(page);
    const separator = view.getByRole("separator").first();

    await expect(separator).toHaveAttribute("aria-label", /Resize .+ column/);
    await expect(separator).toHaveAttribute("aria-orientation", "vertical");
    await expect(separator).toHaveAttribute("aria-valuemin", "64");
    await expect(separator).toHaveAttribute("aria-valuemax", "640");
    await expect(separator).toHaveAttribute("aria-valuenow", "160");
    await expect(separator).toHaveAttribute("aria-valuetext", "160 CSS pixels");
    await expect(separator).toHaveAttribute("tabindex", "0");
    await expect(separator).toHaveAttribute("aria-controls", await grid.getAttribute("id"));
    const target = await separator.boundingBox();
    expect(target).not.toBeNull();
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);

    const activeCellBeforeResize = await grid.getAttribute("aria-activedescendant");
    await separator.focus();
    await separator.evaluate((element) => {
      globalThis.__tabularkOriginalResizeHandle = element;
    });
    const expectStableFocus = async () => {
      await expect.poll(() => page.evaluate(() => (
        document.activeElement === globalThis.__tabularkOriginalResizeHandle
        && globalThis.__tabularkOriginalResizeHandle?.isConnected === true
      ))).toBe(true);
    };

    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "168");
    await expectStableFocus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "200");
    await expectStableFocus();
    await page.keyboard.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "64");
    await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "64");
    await expectStableFocus();
    await page.keyboard.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", "640");
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "640");
    await expectStableFocus();
    await page.keyboard.press("Enter");
    await expect(separator).not.toHaveAttribute("aria-valuenow", "640");
    await expect(separator).toHaveAttribute("aria-valuetext", / CSS pixels$/);
    await expectStableFocus();

    expect(await grid.getAttribute("aria-activedescendant")).toBe(activeCellBeforeResize);
    await expect(view.locator("[data-tabulark-status]")).toContainText("visible content");
    await page.evaluate(() => delete globalThis.__tabularkOriginalResizeHandle);
  });

  test("virtualizes after scrolling and resizes a column by pointer", async ({ page }) => {
    const { view, grid } = await openSample(page);
    const scroller = view.locator(".tabulark-scroll");

    await scroller.evaluate((element) => {
      element.scrollTop = Math.min(20_000, element.scrollHeight - element.clientHeight);
      element.dispatchEvent(new Event("scroll"));
    });

    await expect
      .poll(() =>
        grid.locator('[role="row"]').evaluateAll((rows) =>
          Math.max(...rows.map((row) => Number(row.getAttribute("aria-rowindex") ?? 0))),
        ),
      )
      .toBeGreaterThan(500);
    expect(await grid.locator('[role="row"]').count()).toBeLessThan(100);

    const firstHandle = view.locator("[data-column-resize]").first();
    await expect(firstHandle).toBeAttached();
    const defaultBox = await firstHandle.boundingBox();
    expect(defaultBox).not.toBeNull();
    await firstHandle.dblclick();
    await expect
      .poll(async () => (await firstHandle.boundingBox())?.x ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(defaultBox.x - 70);

    // The table lives inside a scrollable document and its sticky resize
    // layer can be partially clipped after autosizing. Let Playwright resolve
    // a genuinely visible point before reading the coordinates used for the
    // captured pointer drag.
    await firstHandle.hover({ position: { x: 22, y: 12 } });
    const before = await firstHandle.boundingBox();
    expect(before).not.toBeNull();
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 48, before.y + Math.min(before.height / 2, 12));
    await page.mouse.up();

    await expect
      .poll(async () => (await firstHandle.boundingBox())?.x ?? 0)
      .toBeGreaterThan(before.x + 35);
  });

  test("keeps a Worker runtime error visible while ignoring terminal view interactions", async ({ page }) => {
    await page.goto("/test/browser/harness.html");

    const result = await page.evaluate(async () => {
      const { createCanvasTableView } = await import("/dist/index.js");
      const host = document.createElement("div");
      Object.assign(host.style, { height: "220px", width: "420px" });
      document.body.replaceChildren(host);

      const listeners = new Set();
      const table = {
        metadata: {
          tableId: "table-0",
          name: "Failure sample",
          revision: 0,
          extent: {
            rows: { kind: "exact", value: 20 },
            columns: { kind: "exact", value: 2 },
          },
          schema: {
            version: 0,
            columns: [
              { id: "c0", name: "First", index: 0, dataType: { type: "utf8" }, nullable: true },
              { id: "c1", name: "Second", index: 1, dataType: { type: "utf8" }, nullable: true },
            ],
          },
          capabilities: {
            randomAccess: "full",
            typedValues: false,
            search: false,
            sort: false,
            filter: false,
            multiTable: false,
          },
        },
        readRange(_request, options = {}) {
          return new Promise((_, reject) => {
            const cancel = () => {
              const error = new Error("cancelled");
              error.code = "CANCELLED";
              reject(error);
            };
            if (options.signal?.aborted) {
              cancel();
            } else {
              options.signal?.addEventListener("abort", cancel, { once: true });
            }
          });
        },
        async getPresentation() {
          return null;
        },
        async readPresentationRange() {
          return null;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {},
      };

      const errors = [];
      const onError = (event) => {
        errors.push(event.error?.message ?? event.message ?? "window error");
        event.preventDefault();
      };
      const onRejection = (event) => {
        errors.push(event.reason?.message ?? String(event.reason));
        event.preventDefault();
      };
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);

      const view = createCanvasTableView({
        container: host,
        table,
        onError: (error) => errors.push(error?.message ?? String(error)),
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const resizeHandle = view.element.querySelector("[data-column-resize]");
      resizeHandle?.focus({ preventScroll: true });
      const resizeHandleWasFocused = document.activeElement === resizeHandle;

      const runtimeError = new Error("Worker stopped unexpectedly");
      for (const listener of [...listeners]) {
        listener({ type: "runtimeError", error: runtimeError });
      }
      for (const listener of [...listeners]) {
        listener({ type: "closed" });
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const terminalFocusMoved = document.activeElement
        === view.element.querySelector("[data-tabulark-a11y-grid]");

      const scroller = view.element.querySelector("[data-tabulark-scroll]");
      const surface = view.element.querySelector("[data-tabulark-surface]");
      scroller.scrollTop = 100;
      scroller.dispatchEvent(new Event("scroll"));
      host.style.width = "460px";
      window.dispatchEvent(new Event("resize"));
      view.focus({ preventScroll: true });
      view.element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      surface.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 60,
        clientY: 60,
        pointerId: 7,
        pointerType: "mouse",
      }));
      surface.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 80,
        clientY: 80,
        pointerId: 7,
        pointerType: "mouse",
      }));
      surface.dispatchEvent(new MouseEvent("dblclick", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 10,
      }));
      view.element.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowDown",
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const snapshot = view.controller.getSnapshot();
      const message = view.element.querySelector("[data-tabulark-message]")?.textContent ?? "";
      const status = view.element.querySelector("[data-tabulark-status]")?.textContent ?? "";
      const remainingResizeHandles = view.element.querySelectorAll("[data-column-resize]").length;
      const gridFocused = document.activeElement === view.element.querySelector("[data-tabulark-a11y-grid]");
      const output = {
        errors,
        gridFocused,
        message,
        remainingResizeHandles,
        resizeHandleWasFocused,
        status,
        snapshotStatus: snapshot.status,
        terminalFocusMoved,
      };
      view.destroy();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      return output;
    });

    expect(result.errors).toEqual([]);
    expect(result.resizeHandleWasFocused).toBe(true);
    expect(result.gridFocused).toBe(true);
    expect(result.terminalFocusMoved).toBe(true);
    expect(result.remainingResizeHandles).toBe(0);
    expect(result.snapshotStatus).toBe("error");
    expect(result.message).toContain("Worker stopped unexpectedly");
    expect(result.status).toContain("Worker stopped unexpectedly");
  });
});
