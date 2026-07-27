import type { PagedDocumentSession, RenderedDocumentPage } from "./types.js";

export interface PagedDocumentViewOptions {
  readonly container: HTMLElement;
  readonly document: PagedDocumentSession;
  readonly ariaLabel?: string;
  readonly onError?: (error: unknown) => void;
}

type ZoomMode = "fit-width" | "fit-page" | "custom";

export class PagedDocumentView {
  readonly element: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly pages: HTMLElement;
  private readonly pageInput: HTMLInputElement;
  private readonly zoomOutput: HTMLElement;
  private readonly liveRegion: HTMLElement;
  private readonly pageElements: HTMLElement[] = [];
  private readonly renderControllers = new Map<number, AbortController>();
  private readonly rendered = new Set<number>();
  private readonly observer: IntersectionObserver;
  private readonly resizeObserver: ResizeObserver;
  private closed = false;
  private generation = 1;
  private zoomMode: ZoomMode = "fit-width";
  private zoom = 1;
  private resizeFrame = 0;

  constructor(private readonly options: PagedDocumentViewOptions) {
    if (!(options.container instanceof HTMLElement)) throw new TypeError("container must be an HTMLElement");
    const root = document.createElement("section");
    root.className = "tdp-root";
    root.setAttribute("aria-label", options.ariaLabel ?? "Document preview");
    root.innerHTML = `${styles}
      <nav class="tdp-toolbar" aria-label="Document page controls">
        <button type="button" data-action="previous" aria-label="Previous page">${chevron("left")}</button>
        <label class="tdp-page-label">Page <input data-page type="number" min="1" max="${options.document.pageCount}" value="1" inputmode="numeric" aria-label="Current page"> <span aria-hidden="true">/ ${options.document.pageCount}</span></label>
        <button type="button" data-action="next" aria-label="Next page">${chevron("right")}</button>
        <span class="tdp-divider" aria-hidden="true"></span>
        <button type="button" data-action="minus" aria-label="Zoom out">${minusIcon()}</button>
        <output class="tdp-zoom" aria-label="Zoom level">Fit width</output>
        <button type="button" data-action="plus" aria-label="Zoom in">${plusIcon()}</button>
        <button type="button" data-action="actual">100%</button>
        <button type="button" data-action="fit-width">Fit width</button>
        <button type="button" data-action="fit-page">Fit page</button>
      </nav>
      <div class="tdp-viewport" tabindex="0" role="group" aria-label="Document pages">
        <div class="tdp-pages"></div>
      </div>
      <div class="tdp-live" aria-live="polite" aria-atomic="true"></div>`;
    this.element = root;
    this.viewport = required(root, ".tdp-viewport");
    this.pages = required(root, ".tdp-pages");
    this.pageInput = required(root, "[data-page]");
    this.zoomOutput = required(root, ".tdp-zoom");
    this.liveRegion = required(root, ".tdp-live");
    this.createPlaceholders();
    this.observer = new IntersectionObserver(this.onIntersection, {
      root: this.viewport,
      rootMargin: "0px",
      threshold: 0.01,
    });
    for (const page of this.pageElements) this.observer.observe(page);
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(this.viewport);
    root.addEventListener("click", this.onClick);
    this.pageInput.addEventListener("change", this.onPageChange);
    this.viewport.addEventListener("keydown", this.onKeyDown);
    this.viewport.addEventListener("scroll", this.onScroll, { passive: true });
    options.container.replaceChildren(root);
    void this.loadPageGeometry();
  }

  focus(options?: FocusOptions): void {
    this.viewport.focus(options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    cancelAnimationFrame(this.resizeFrame);
    this.observer.disconnect();
    this.resizeObserver.disconnect();
    for (const controller of this.renderControllers.values()) controller.abort();
    this.renderControllers.clear();
    this.rendered.clear();
    this.element.removeEventListener("click", this.onClick);
    this.pageInput.removeEventListener("change", this.onPageChange);
    this.viewport.removeEventListener("keydown", this.onKeyDown);
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.element.remove();
  }

  private createPlaceholders(): void {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < this.options.document.pageCount; index += 1) {
      const page = document.createElement("figure");
      page.className = "tdp-page";
      page.dataset.pageIndex = String(index);
      page.setAttribute("role", "group");
      page.setAttribute("aria-label", `Page ${index + 1} of ${this.options.document.pageCount}`);
      page.style.aspectRatio = "8.5 / 11";
      page.innerHTML = `<canvas aria-label="Rendered page ${index + 1}"></canvas><div class="tdp-skeleton" aria-hidden="true"></div><figcaption>Page ${index + 1}</figcaption>`;
      this.pageElements.push(page);
      fragment.append(page);
    }
    this.pages.append(fragment);
  }

  private async loadPageGeometry(): Promise<void> {
    for (let index = 0; index < this.pageElements.length; index += 1) {
      const element = this.pageElements[index];
      if (element === undefined || this.closed) return;
      try {
        const info = await this.options.document.getPageInfo(index);
        if (this.closed) return;
        element.style.aspectRatio = `${info.width} / ${info.height}`;
      } catch (error) {
        this.report(error);
      }
    }
    this.applyZoom();
  }

  private readonly onIntersection = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.pageIndex);
      if (entry.isIntersecting) {
        for (let candidate = Math.max(0, index - 1); candidate <= Math.min(this.pageElements.length - 1, index + 1); candidate += 1) {
          void this.render(candidate);
        }
      } else if (distanceFromViewport(entry.boundingClientRect, this.viewport.getBoundingClientRect()) > this.viewport.clientHeight * 2) {
        this.release(index);
      }
    }
  };

  private async render(index: number): Promise<void> {
    if (this.closed || this.renderControllers.has(index)) return;
    const element = this.pageElements[index];
    if (element === undefined) return;
    const width = Math.max(1, Math.floor(element.getBoundingClientRect().width));
    if (width <= 1) return;
    const previous = this.rendered.has(index);
    if (previous) this.release(index);
    const controller = new AbortController();
    this.renderControllers.set(index, controller);
    const generation = this.generation;
    element.classList.add("tdp-loading");
    try {
      const page = await this.options.document.renderPage(index, {
        cssWidth: width,
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        signal: controller.signal,
      });
      if (this.closed || controller.signal.aborted || generation !== this.generation) return;
      this.paint(element, page);
      this.rendered.add(index);
      element.classList.remove("tdp-loading");
      element.classList.add("tdp-rendered");
      this.liveRegion.textContent = `Page ${index + 1} rendered`;
    } catch (error) {
      if (!controller.signal.aborted) {
        element.classList.remove("tdp-loading");
        element.classList.add("tdp-error");
        this.liveRegion.textContent = `Page ${index + 1} could not be rendered`;
        this.report(error);
      }
    } finally {
      if (this.renderControllers.get(index) === controller) this.renderControllers.delete(index);
    }
  }

  private paint(element: HTMLElement, page: RenderedDocumentPage): void {
    const canvas = required<HTMLCanvasElement>(element, "canvas");
    canvas.width = page.width;
    canvas.height = page.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("Canvas 2D is unavailable");
    const pixels = new Uint8ClampedArray(page.pixels);
    context.putImageData(new ImageData(pixels, page.width, page.height), 0, 0);
  }

  private release(index: number): void {
    this.renderControllers.get(index)?.abort();
    this.renderControllers.delete(index);
    const element = this.pageElements[index];
    if (element === undefined) return;
    const canvas = element.querySelector("canvas");
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
    element.classList.remove("tdp-rendered", "tdp-loading");
    this.rendered.delete(index);
  }

  private readonly onClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-action]");
    if (button === null || button === undefined) return;
    switch (button.dataset.action) {
      case "previous": this.goTo(this.currentPage() - 1); break;
      case "next": this.goTo(this.currentPage() + 1); break;
      case "minus": this.setCustomZoom(this.zoom / 1.2); break;
      case "plus": this.setCustomZoom(this.zoom * 1.2); break;
      case "actual": this.setCustomZoom(1); break;
      case "fit-width": this.zoomMode = "fit-width"; this.applyZoom(); break;
      case "fit-page": this.zoomMode = "fit-page"; this.applyZoom(); break;
    }
  };

  private readonly onPageChange = (): void => this.goTo(Number(this.pageInput.value) - 1);

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case "PageUp": case "ArrowUp": this.goTo(this.currentPage() - 1); event.preventDefault(); break;
      case "PageDown": case "ArrowDown": this.goTo(this.currentPage() + 1); event.preventDefault(); break;
      case "Home": this.goTo(0); event.preventDefault(); break;
      case "End": this.goTo(this.pageElements.length - 1); event.preventDefault(); break;
      case "+": case "=": this.setCustomZoom(this.zoom * 1.2); event.preventDefault(); break;
      case "-": this.setCustomZoom(this.zoom / 1.2); event.preventDefault(); break;
      case "0": this.setCustomZoom(1); event.preventDefault(); break;
    }
  };

  private readonly onScroll = (): void => {
    this.pageInput.value = String(this.currentPage() + 1);
  };

  private currentPage(): number {
    const viewportTop = this.viewport.getBoundingClientRect().top;
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.pageElements.length; index += 1) {
      const next = Math.abs((this.pageElements[index]?.getBoundingClientRect().top ?? 0) - viewportTop - 16);
      if (next < distance) { distance = next; closest = index; }
    }
    return closest;
  }

  private goTo(index: number): void {
    const bounded = Math.min(this.pageElements.length - 1, Math.max(0, index));
    this.pageInput.value = String(bounded + 1);
    this.pageElements[bounded]?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  }

  private setCustomZoom(value: number): void {
    this.zoomMode = "custom";
    this.zoom = Math.min(4, Math.max(0.25, value));
    this.applyZoom();
  }

  private applyZoom(): void {
    const availableWidth = Math.max(160, this.viewport.clientWidth - 32);
    const availableHeight = Math.max(160, this.viewport.clientHeight - 64);
    for (const page of this.pageElements) {
      const [ratioWidth = 8.5, ratioHeight = 11] = page.style.aspectRatio.split("/").map(Number);
      let width: number;
      if (this.zoomMode === "fit-width") width = availableWidth;
      else if (this.zoomMode === "fit-page") width = Math.min(availableWidth, availableHeight * ratioWidth / ratioHeight);
      else width = 816 * this.zoom * ratioWidth / 8.5;
      page.style.width = `${Math.max(120, Math.round(width))}px`;
    }
    this.zoomOutput.textContent = this.zoomMode === "fit-width" ? "Fit width"
      : this.zoomMode === "fit-page" ? "Fit page" : `${Math.round(this.zoom * 100)}%`;
    this.generation += 1;
    for (const controller of this.renderControllers.values()) controller.abort();
    this.renderControllers.clear();
    for (const index of [...this.rendered]) this.release(index);
    requestAnimationFrame(() => {
      if (this.closed) return;
      const current = this.currentPage();
      for (let index = Math.max(0, current - 1); index <= Math.min(this.pageElements.length - 1, current + 1); index += 1) {
        void this.render(index);
      }
    });
  }

  private scheduleResize(): void {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      if (this.zoomMode !== "custom") this.applyZoom();
    });
  }

  private report(error: unknown): void {
    this.options.onError?.(error);
  }
}

export function createPagedDocumentView(options: PagedDocumentViewOptions): PagedDocumentView {
  return new PagedDocumentView(options);
}

function required<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing document view element: ${selector}`);
  return element;
}

function distanceFromViewport(page: DOMRect, viewport: DOMRect): number {
  if (page.bottom < viewport.top) return viewport.top - page.bottom;
  if (page.top > viewport.bottom) return page.top - viewport.bottom;
  return 0;
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function chevron(direction: "left" | "right"): string {
  const path = direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6";
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function plusIcon(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
}

function minusIcon(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>`;
}

const styles = `<style>
  .tdp-root{--tdp-bg:#e9edf2;--tdp-surface:#fff;--tdp-text:#17202a;--tdp-muted:#5d6977;--tdp-border:#c8d0da;--tdp-focus:#1769e0;display:grid;grid-template-rows:auto minmax(0,1fr);height:100%;min-height:360px;color:var(--tdp-text);background:var(--tdp-bg);font:500 14px/1.5 system-ui,sans-serif}
  .tdp-toolbar{display:flex;align-items:center;gap:8px;min-height:56px;padding:8px 12px;background:var(--tdp-surface);border-bottom:1px solid var(--tdp-border);overflow-x:auto}
  .tdp-toolbar button{min-width:44px;min-height:44px;padding:0 12px;border:1px solid var(--tdp-border);border-radius:8px;background:var(--tdp-surface);color:var(--tdp-text);font:inherit;cursor:pointer;white-space:nowrap;transition:background-color 180ms ease,border-color 180ms ease}
  .tdp-toolbar button:hover{background:#eef4ff;border-color:#8babe0}.tdp-toolbar button:active{background:#dbe8fb}.tdp-toolbar button:focus-visible,.tdp-viewport:focus-visible,.tdp-page-label input:focus-visible{outline:3px solid var(--tdp-focus);outline-offset:2px}
  .tdp-toolbar svg{display:block;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .tdp-page-label{display:flex;align-items:center;gap:6px;white-space:nowrap}.tdp-page-label input{width:56px;min-height:40px;border:1px solid var(--tdp-border);border-radius:7px;text-align:center;font:inherit}.tdp-divider{height:28px;border-left:1px solid var(--tdp-border)}.tdp-zoom{min-width:64px;text-align:center;color:var(--tdp-muted);font-variant-numeric:tabular-nums}
  .tdp-viewport{min-height:0;overflow:auto;scrollbar-gutter:stable;background:var(--tdp-bg)}.tdp-pages{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px 16px 72px}
  .tdp-page{position:relative;flex:none;max-width:100%;margin:0;background:var(--tdp-surface);box-shadow:0 2px 10px rgb(23 32 42 / .18);overflow:hidden}.tdp-page canvas{display:block;width:100%;height:100%}.tdp-page figcaption{position:absolute;top:100%;left:0;width:100%;padding-top:4px;color:var(--tdp-muted);font-size:12px;text-align:center;font-variant-numeric:tabular-nums}.tdp-skeleton{position:absolute;inset:0;background:linear-gradient(100deg,#fff 35%,#f2f5f8 50%,#fff 65%);background-size:220% 100%}.tdp-rendered .tdp-skeleton{display:none}.tdp-error .tdp-skeleton{background:#fff1f1}.tdp-live{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  @media (prefers-color-scheme:dark){.tdp-root{--tdp-bg:#171b20;--tdp-surface:#252b33;--tdp-text:#f2f5f8;--tdp-muted:#b7c0cb;--tdp-border:#4b5663;--tdp-focus:#74a9ff}.tdp-toolbar button:hover{background:#303d50;border-color:#7194c5}.tdp-toolbar button:active{background:#3a4b62}.tdp-page{background:#fff}.tdp-skeleton{background:linear-gradient(100deg,#f8f8f8 35%,#e4e8ed 50%,#f8f8f8 65%);background-size:220% 100%}}
  @media (prefers-reduced-motion:no-preference){.tdp-loading .tdp-skeleton{animation:tdp-shimmer 1.5s ease-in-out infinite}@keyframes tdp-shimmer{to{background-position-x:-220%}}}
  @media (max-width:640px){.tdp-toolbar{padding-inline:8px}.tdp-pages{padding-inline:8px}.tdp-divider{display:none}}
</style>`;
