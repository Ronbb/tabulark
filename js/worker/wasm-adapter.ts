import { ProtocolFault, faultFromUnknown } from "./worker-errors.js";
import {
  ADAPTER_API_VERSION,
  BATCH_LAYOUT_VERSION,
  PROTOCOL_VERSION,
} from "../protocol.js";
import type { OfficialAdapterId } from "../adapters.js";

interface RawWasmRuntime {
  protocolVersion(): number;
  adapterApiVersion(): number;
  batchLayoutVersion(): number;
  adapterId(): string;
  beginOpen(options: unknown, sourceLength: number): unknown;
  continueOperation(
    operationHandle: string | number,
    absoluteOffset: number,
    bytes: Uint8Array,
    eof: boolean,
  ): unknown;
  openTable(sourceHandle: string | number, tableId: string): unknown;
  metadata(handle: string | number): unknown;
  presentation(handle: string | number): unknown;
  readPresentationRange(handle: string | number, request: unknown): unknown;
  beginRead(tableHandle: string | number, request: unknown): unknown;
  cancelOperation(operationHandle: string | number): unknown;
  closeTable(tableHandle: string | number): unknown;
  closeSource(sourceHandle: string | number): unknown;
  shutdown(): unknown;
  free?(): void;
}

interface WasmBindings {
  default(input?: unknown): Promise<unknown> | unknown;
  WasmRuntime?: new (config: unknown) => RawWasmRuntime;
}

interface AdapterPendingRead {
  readonly operationHandle: string | number;
  readonly action: Readonly<{
    readonly kind: "read-bytes";
    readonly offset: number;
    readonly length: number;
  }>;
}

export interface AdapterReadBytesStep extends AdapterPendingRead {
  readonly kind: "read-bytes";
}

export interface AdapterOpenProgressStep extends AdapterPendingRead {
  readonly kind: "open-progress";
  readonly sourceHandle: string | number;
  readonly tables: unknown;
  readonly metadata: unknown;
  readonly progress: unknown;
  readonly warnings?: unknown;
}

export interface AdapterOpenCompleteStep {
  readonly kind: "open-complete";
  readonly sourceHandle: string | number;
  readonly tables: unknown;
  readonly metadata: unknown;
  readonly progress?: unknown;
  readonly warnings?: unknown;
}

export interface AdapterReadCompleteStep {
  readonly kind: "read-complete";
  readonly batch: unknown;
}

export type AdapterOpenStep = AdapterReadBytesStep | AdapterOpenProgressStep | AdapterOpenCompleteStep;
export type AdapterReadStep = AdapterReadBytesStep | AdapterReadCompleteStep;
export type AdapterOperationStep = AdapterOpenStep | AdapterReadStep;

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

  static async load(
    moduleUrl: string,
    expectedAdapterId: OfficialAdapterId,
    config: unknown,
  ): Promise<WasmAdapter> {
    let bindings: WasmBindings;
    try {
      bindings = (await import(/* @vite-ignore */ moduleUrl)) as WasmBindings;
      if (typeof bindings.default !== "function") {
        throw new TypeError("The WebAssembly module does not export a default initializer");
      }
      await bindings.default();
      const Runtime = bindings.WasmRuntime;
      if (typeof Runtime !== "function") {
        throw new ProtocolFault(
          "PROTOCOL_INCOMPATIBLE",
          `The ${expectedAdapterId} artifact does not export its official runtime class`,
        );
      }
      const adapter = new WasmAdapter(new Runtime(config));
      try {
        adapter.#validateContract(expectedAdapterId);
      } catch (error) {
        try {
          adapter.dispose();
        } catch {
          // Preserve the ABI validation fault after making a best-effort
          // release of the just-constructed wasm-bindgen runtime.
        }
        throw error;
      }
      return adapter;
    } catch (error) {
      if (error instanceof ProtocolFault) {
        throw error;
      }
      throw new ProtocolFault(
        "RUNTIME_FAILURE",
        "Failed to initialize the Tabulark WebAssembly runtime",
        false,
        { moduleUrl },
        error,
      );
    }
  }

  metadata(sourceHandle: string | number): unknown {
    return this.#call("metadata", () => this.#runtime.metadata(sourceHandle));
  }

  presentation(tableHandle: string | number): unknown {
    return this.#call("presentation", () => this.#runtime.presentation(tableHandle));
  }

  readPresentationRange(tableHandle: string | number, request: unknown): unknown {
    return this.#call(
      "readPresentationRange",
      () => this.#runtime.readPresentationRange(tableHandle, request),
    );
  }

  beginOpen(options: unknown, sourceLength: number): AdapterOpenStep {
    return this.#call("beginOpen", () => this.#runtime.beginOpen(options, sourceLength));
  }

  continueOperation(
    operationHandle: string | number,
    absoluteOffset: number,
    bytes: Uint8Array,
    eof: boolean,
  ): AdapterOperationStep {
    return this.#call("continueOperation", () =>
      this.#runtime.continueOperation(operationHandle, absoluteOffset, bytes, eof),
    );
  }

  openTable(sourceHandle: string | number, tableId: string): unknown {
    return this.#call("openTable", () => this.#runtime.openTable(sourceHandle, tableId));
  }

  beginRead(tableHandle: string | number, request: unknown): AdapterReadStep {
    return this.#call("beginRead", () => this.#runtime.beginRead(tableHandle, request));
  }

  cancelOperation(operationHandle: string | number): void {
    this.#call("cancelOperation", () => this.#runtime.cancelOperation(operationHandle));
  }

  closeTable(tableHandle: string | number): void {
    this.#call("closeTable", () => this.#runtime.closeTable(tableHandle));
  }

  closeSource(sourceHandle: string | number): void {
    this.#call("closeSource", () => this.#runtime.closeSource(sourceHandle));
  }

  dispose(): void {
    try {
      this.#runtime.shutdown();
    } catch {
      // free() still owns the wasm-bindgen allocation after shutdown failure.
    }
    this.#runtime.free?.();
  }

  #validateContract(expectedAdapterId: OfficialAdapterId): void {
    const runtime = this.#runtime as Partial<RawWasmRuntime>;
    const required = [
      "protocolVersion",
      "adapterApiVersion",
      "batchLayoutVersion",
      "adapterId",
      "beginOpen",
      "continueOperation",
      "openTable",
      "metadata",
      "presentation",
      "readPresentationRange",
      "beginRead",
      "cancelOperation",
      "closeTable",
      "closeSource",
      "shutdown",
    ] as const;
    for (const name of required) {
      if (typeof runtime[name] !== "function") {
        throw new ProtocolFault(
          "PROTOCOL_INCOMPATIBLE",
          `WebAssembly adapter does not export ${name}`,
        );
      }
    }
    const protocolVersion = this.#call("protocolVersion", () => this.#runtime.protocolVersion());
    const adapterVersion = this.#call("adapterApiVersion", () => this.#runtime.adapterApiVersion());
    const layoutVersion = this.#call("batchLayoutVersion", () => this.#runtime.batchLayoutVersion());
    const adapterId = this.#call("adapterId", () => this.#runtime.adapterId());
    if (
      protocolVersion !== PROTOCOL_VERSION
      || adapterVersion !== ADAPTER_API_VERSION
      || layoutVersion !== BATCH_LAYOUT_VERSION
      || adapterId !== expectedAdapterId
    ) {
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        `Adapter ${adapterId} protocol/ABI/layout ${protocolVersion}/${adapterVersion}/${layoutVersion} is incompatible with ${expectedAdapterId} ${PROTOCOL_VERSION}/${ADAPTER_API_VERSION}/${BATCH_LAYOUT_VERSION}`,
      );
    }
  }

  #call<T>(operation: string, call: () => unknown): T {
    try {
      return call() as T;
    } catch (error) {
      throw faultFromUnknown(error, `WebAssembly ${operation} failed`);
    }
  }
}
