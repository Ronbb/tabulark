import { ProtocolFault, faultFromUnknown } from "./worker-errors.js";

export interface WasmOpenResult {
  readonly sourceHandle: string | number;
  readonly tables?: readonly unknown[];
  readonly table?: unknown;
  readonly metadata?: unknown;
}

export interface WasmScanUpdate {
  readonly metadata?: unknown;
  readonly warnings?: readonly unknown[];
  readonly warning?: unknown;
  readonly done?: boolean;
}

export interface WasmRangeStart {
  readonly cursorHandle: string | number;
  readonly byteOffset: number;
  readonly checkpointRow: number;
  readonly done?: boolean;
  readonly batch?: unknown;
}

export interface WasmRangeUpdate {
  readonly done: boolean;
  readonly batch?: unknown;
  readonly nextByteOffset?: number;
}

interface RawWasmRuntime {
  openDelimited(options: unknown): unknown;
  scanChunk(
    sourceHandle: string | number,
    absoluteOffset: number,
    bytes: Uint8Array,
    eof: boolean,
  ): unknown;
  metadata(sourceHandle: string | number): unknown;
  beginRange(sourceHandle: string | number, request: unknown): unknown;
  feedRange(
    cursorHandle: string | number,
    absoluteOffset: number,
    bytes: Uint8Array,
    eof: boolean,
  ): unknown;
  cancel(cursorHandle: string | number): unknown;
  closeRange(cursorHandle: string | number): unknown;
  closeSource(sourceHandle: string | number): unknown;
  free?(): void;
}

interface WasmBindings {
  default(input?: unknown): Promise<unknown> | unknown;
  WasmRuntime: new (config: unknown) => RawWasmRuntime;
}

/**
 * The sole translation layer between the Worker protocol and wasm-bindgen.
 * Bulk arrays are copied by the Worker before they are transferred, never by
 * this adapter, so the runtime may safely return views into WebAssembly memory.
 */
export class WasmAdapter {
  readonly #runtime: RawWasmRuntime;

  private constructor(runtime: RawWasmRuntime) {
    this.#runtime = runtime;
  }

  static async load(moduleUrl: string, config: unknown): Promise<WasmAdapter> {
    let bindings: WasmBindings;
    try {
      bindings = (await import(/* @vite-ignore */ moduleUrl)) as WasmBindings;
      if (typeof bindings.default !== "function") {
        throw new TypeError("The WebAssembly module does not export a default initializer");
      }
      await bindings.default();
      if (typeof bindings.WasmRuntime !== "function") {
        throw new TypeError("The WebAssembly module does not export WasmRuntime");
      }
      return new WasmAdapter(new bindings.WasmRuntime(config));
    } catch (error) {
      throw new ProtocolFault(
        "RUNTIME_FAILURE",
        "Failed to initialize the Tabulark WebAssembly runtime",
        false,
        { moduleUrl },
        error,
      );
    }
  }

  openDelimited(options: unknown): WasmOpenResult {
    return this.#call("openDelimited", () => this.#runtime.openDelimited(options));
  }

  scanChunk(
    sourceHandle: string | number,
    absoluteOffset: number,
    bytes: Uint8Array,
    eof: boolean,
  ): WasmScanUpdate {
    return this.#call("scanChunk", () =>
      this.#runtime.scanChunk(sourceHandle, absoluteOffset, bytes, eof),
    );
  }

  metadata(sourceHandle: string | number): unknown {
    return this.#call("metadata", () => this.#runtime.metadata(sourceHandle));
  }

  beginRange(sourceHandle: string | number, request: unknown): WasmRangeStart {
    const result = this.#call<Record<string, unknown>>("beginRange", () =>
      this.#runtime.beginRange(sourceHandle, request),
    );
    const plan = isRecord(result.plan) ? result.plan : {};
    const checkpoint = isRecord(plan.checkpoint) ? plan.checkpoint : {};
    return {
      cursorHandle: handle(result.cursorHandle ?? result.rangeHandle, "beginRange"),
      byteOffset: nonNegativeNumber(
        result.byteOffset ?? checkpoint.byteOffset ?? plan.sourceOffset,
        "beginRange byteOffset",
      ),
      checkpointRow: nonNegativeNumber(checkpoint.row ?? result.checkpointRow, "beginRange checkpointRow"),
      done: result.done === true || result.batch !== undefined,
      ...(result.batch === undefined ? {} : { batch: result.batch }),
    };
  }

  feedRange(
    cursorHandle: string | number,
    absoluteOffset: number,
    bytes: Uint8Array,
    eof: boolean,
  ): WasmRangeUpdate {
    const result = this.#call<Record<string, unknown>>("feedRange", () =>
      this.#runtime.feedRange(cursorHandle, absoluteOffset, bytes, eof),
    );
    if (result.status === "complete") {
      return { done: true, ...(result.batch === undefined ? {} : { batch: result.batch }) };
    }
    if (result.status === "need-more") {
      return {
        done: false,
        nextByteOffset: nonNegativeNumber(result.expectedOffset, "feedRange expectedOffset"),
      };
    }
    // The provisional contract also permits a direct {done, batch} shape.
    if (typeof result.done === "boolean") {
      return {
        done: result.done,
        ...(result.batch === undefined ? {} : { batch: result.batch }),
        ...(result.nextByteOffset === undefined
          ? {}
          : { nextByteOffset: nonNegativeNumber(result.nextByteOffset, "feedRange nextByteOffset") }),
      };
    }
    throw new ProtocolFault("RUNTIME_FAILURE", "feedRange returned an unknown result shape");
  }

  cancel(cursorHandle: string | number): void {
    this.#call("cancel", () => this.#runtime.cancel(cursorHandle));
  }

  closeRange(cursorHandle: string | number): void {
    this.#call("closeRange", () => this.#runtime.closeRange(cursorHandle));
  }

  closeSource(sourceHandle: string | number): void {
    this.#call("closeSource", () => this.#runtime.closeSource(sourceHandle));
  }

  dispose(): void {
    this.#runtime.free?.();
  }

  #call<T>(operation: string, call: () => unknown): T {
    try {
      return call() as T;
    } catch (error) {
      throw faultFromUnknown(error, `WebAssembly ${operation} failed`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function handle(value: unknown, operation: string): string | number {
  if (typeof value === "string") {
    return value;
  }
  if (Number.isSafeInteger(value) && (value as number) >= 0) {
    return value as number;
  }
  throw new ProtocolFault("RUNTIME_FAILURE", `${operation} did not return a handle`);
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolFault("RUNTIME_FAILURE", `${field} must be a non-negative safe integer`);
  }
  return value as number;
}
