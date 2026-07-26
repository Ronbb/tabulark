import { ProtocolFault, faultFromUnknown } from "./worker-errors.js";
import {
  ADAPTER_API_VERSION,
  BATCH_LAYOUT_VERSION,
  PROTOCOL_VERSION,
  isRecord,
} from "../protocol.js";
import type { OfficialAdapterId } from "../adapters.js";

interface RawWasmRuntime {
  protocolVersion(): number;
  adapterApiVersion(): number;
  batchLayoutVersion(): number;
  adapterId(): string;
  beginOpen(options: unknown, sourceLength: number): unknown;
  beginOpenTable(sourceHandle: string | number, tableId: string): unknown;
  beginMetadata(tableHandle: string | number): unknown;
  beginPresentation(tableHandle: string | number): unknown;
  beginPresentationRange(tableHandle: string | number, request: unknown): unknown;
  continueOperation(
    operationHandle: string | number,
    operationRevision: number,
    results: readonly AdapterActionResult[],
  ): unknown;
  beginRead(tableHandle: string | number, request: unknown): unknown;
  cancelOperation(operationHandle: string | number): unknown;
  closeTable(tableHandle: string | number): unknown;
  closeSource(sourceHandle: string | number): unknown;
  shutdown(): unknown;
  free?(): void;
}

/** Private runtime seam shared by the compiled adapters. */
export interface AdapterRuntime {
  beginOpen(options: unknown, sourceLength: number): unknown | Promise<unknown>;
  beginOpenTable(sourceHandle: string | number, tableId: string): unknown | Promise<unknown>;
  beginMetadata(tableHandle: string | number): unknown | Promise<unknown>;
  beginPresentation(tableHandle: string | number): unknown | Promise<unknown>;
  beginPresentationRange(tableHandle: string | number, request: unknown): unknown | Promise<unknown>;
  continueOperation(
    operationHandle: string | number,
    operationRevision: number,
    results: readonly AdapterActionResult[],
  ): unknown | Promise<unknown>;
  beginRead(tableHandle: string | number, request: unknown): unknown | Promise<unknown>;
  cancelOperation(operationHandle: string | number): unknown;
  closeTable(tableHandle: string | number): unknown;
  closeSource(sourceHandle: string | number): unknown;
  shutdown(): unknown;
  dispose?(): void;
}

interface WasmBindings {
  default(input?: unknown): Promise<unknown> | unknown;
  WasmRuntime?: new (config: unknown) => RawWasmRuntime;
}

export interface AdapterReadAction {
  readonly kind: "read-bytes";
  readonly actionIndex: number;
  readonly offset: number;
  readonly length: number;
}

export interface AdapterActionResult {
  readonly actionIndex: number;
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly eof: boolean;
}

export interface AdapterOperationStep {
  readonly kind: "pending" | "progress" | "complete";
  readonly operationHandle: string | number;
  readonly operationRevision: number;
  readonly actions: readonly AdapterReadAction[];
  readonly cooperativeYield: boolean;
  readonly payload?: unknown;
}

interface TrackedAdapterOperation {
  readonly revision: number;
  readonly actions: readonly AdapterReadAction[];
}

/**
 * The sole translation layer between the Worker protocol and wasm-bindgen.
 * Bulk arrays are copied by the Worker before they are transferred, never by
 * this adapter, so the runtime may safely return views into WebAssembly memory.
 */
export class WasmAdapter implements AdapterRuntime {
  readonly #runtime: RawWasmRuntime;
  readonly #operations = new Map<string | number, TrackedAdapterOperation>();

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

  beginOpen(options: unknown, sourceLength: number): AdapterOperationStep | Promise<AdapterOperationStep> {
    return this.#callMapped(
      "beginOpen",
      () => this.#runtime.beginOpen(options, sourceLength),
      (value) => this.#acceptInitialStep(value, "open"),
    );
  }

  beginOpenTable(sourceHandle: string | number, tableId: string): AdapterOperationStep | Promise<AdapterOperationStep> {
    return this.#callMapped(
      "beginOpenTable",
      () => this.#runtime.beginOpenTable(sourceHandle, tableId),
      (value) => this.#acceptInitialStep(value, "open-table"),
    );
  }

  beginMetadata(tableHandle: string | number): AdapterOperationStep | Promise<AdapterOperationStep> {
    return this.#callMapped(
      "beginMetadata",
      () => this.#runtime.beginMetadata(tableHandle),
      (value) => this.#acceptInitialStep(value, "metadata"),
    );
  }

  beginPresentation(tableHandle: string | number): AdapterOperationStep | Promise<AdapterOperationStep> {
    return this.#callMapped(
      "beginPresentation",
      () => this.#runtime.beginPresentation(tableHandle),
      (value) => this.#acceptInitialStep(value, "presentation"),
    );
  }

  beginPresentationRange(
    tableHandle: string | number,
    request: unknown,
  ): AdapterOperationStep | Promise<AdapterOperationStep> {
    return this.#callMapped(
      "beginPresentationRange",
      () => this.#runtime.beginPresentationRange(tableHandle, request),
      (value) => this.#acceptInitialStep(value, "presentation-range"),
    );
  }

  continueOperation(
    operationHandle: string | number,
    operationRevision: number,
    results: readonly AdapterActionResult[],
  ): AdapterOperationStep | Promise<AdapterOperationStep> {
    const tracked = this.#operations.get(operationHandle);
    if (!tracked) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter operation handle is missing or closed");
    }
    if (operationRevision !== tracked.revision) {
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        `Adapter operation revision ${operationRevision} is stale; expected ${tracked.revision}`,
      );
    }
    const normalizedResults = validateActionResults(results, tracked.actions);
    return this.#callMapped(
      "continueOperation",
      () => this.#runtime.continueOperation(operationHandle, operationRevision, normalizedResults),
      (value) => this.#acceptContinuedStep(value, operationHandle, tracked.revision),
    );
  }

  beginRead(tableHandle: string | number, request: unknown): AdapterOperationStep | Promise<AdapterOperationStep> {
    return this.#callMapped(
      "beginRead",
      () => this.#runtime.beginRead(tableHandle, request),
      (value) => this.#acceptInitialStep(value, "read"),
    );
  }

  cancelOperation(operationHandle: string | number): void {
    this.#operations.delete(operationHandle);
    this.#call("cancelOperation", () => this.#runtime.cancelOperation(operationHandle));
  }

  closeTable(tableHandle: string | number): void {
    this.#call("closeTable", () => this.#runtime.closeTable(tableHandle));
  }

  closeSource(sourceHandle: string | number): void {
    this.#call("closeSource", () => this.#runtime.closeSource(sourceHandle));
  }

  shutdown(): void {
    this.#operations.clear();
    this.#call("shutdown", () => this.#runtime.shutdown());
  }

  dispose(): void {
    try {
      this.shutdown();
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
      "beginOpenTable",
      "beginMetadata",
      "beginPresentation",
      "beginPresentationRange",
      "continueOperation",
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

  #callMapped<T>(
    operation: string,
    call: () => unknown,
    map: (value: unknown) => T,
  ): T | Promise<T> {
    let value: unknown;
    try {
      value = call();
    } catch (error) {
      throw faultFromUnknown(error, `WebAssembly ${operation} failed`);
    }
    if (isPromiseLike(value)) {
      return Promise.resolve(value).then(
        map,
        (error) => { throw faultFromUnknown(error, `WebAssembly ${operation} failed`); },
      );
    }
    return map(value);
  }

  #acceptInitialStep(value: unknown, operation: string): AdapterOperationStep {
    const step = normalizeOperationStep(value);
    if (step.operationRevision !== 1) {
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        `Adapter ${operation} operation must begin at revision 1`,
      );
    }
    if (this.#operations.has(step.operationHandle)) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter reused an active operation handle");
    }
    this.#trackStep(step);
    return step;
  }

  #acceptContinuedStep(
    value: unknown,
    operationHandle: string | number,
    previousRevision: number,
  ): AdapterOperationStep {
    const step = normalizeOperationStep(value);
    if (step.operationHandle !== operationHandle) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter changed its operation handle");
    }
    if (step.operationRevision !== previousRevision + 1) {
      throw new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        "Adapter returned a missing, duplicate, or stale operation revision",
      );
    }
    this.#trackStep(step);
    return step;
  }

  #trackStep(step: AdapterOperationStep): void {
    if (step.kind === "complete") {
      this.#operations.delete(step.operationHandle);
      return;
    }
    this.#operations.set(step.operationHandle, Object.freeze({
      revision: step.operationRevision,
      actions: step.actions,
    }));
  }
}

const MAX_ACTIONS_PER_STEP = 32;

function normalizeOperationStep(value: unknown): AdapterOperationStep {
  if (!isRecord(value)) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter operation step must be an object");
  }
  const kind = value.kind;
  if (kind !== "pending" && kind !== "progress" && kind !== "complete") {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter operation step has an invalid kind");
  }
  const operationHandle = normalizeHandle(value.operationHandle, "operationHandle");
  const operationRevision = positiveSafeInteger(value.operationRevision, "operationRevision");
  if (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS_PER_STEP) {
    throw new ProtocolFault(
      "PROTOCOL_INCOMPATIBLE",
      `Adapter operation step may request at most ${MAX_ACTIONS_PER_STEP} ranges`,
    );
  }
  const indexes = new Set<number>();
  let totalBytes = 0;
  const actions = value.actions.map((entry, position) => {
    if (!isRecord(entry) || entry.kind !== "read-bytes") {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `Adapter action ${position} is invalid`);
    }
    const actionIndex = nonNegativeSafeInteger(entry.actionIndex, `actions[${position}].actionIndex`);
    if (actionIndex > 0xffff_ffff || indexes.has(actionIndex)) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter action indexes must be unique u32 values");
    }
    indexes.add(actionIndex);
    const offset = nonNegativeSafeInteger(entry.offset, `actions[${position}].offset`);
    const length = nonNegativeSafeInteger(entry.length, `actions[${position}].length`);
    totalBytes += length;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter action bytes overflow safe integers");
    }
    return Object.freeze({ kind: "read-bytes" as const, actionIndex, offset, length });
  });
  const cooperativeYield = value.cooperativeYield === true;
  if (kind === "complete" && (actions.length !== 0 || cooperativeYield)) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "A complete adapter step requested more work");
  }
  if (kind !== "complete" && actions.length === 0 && !cooperativeYield) {
    throw new ProtocolFault(
      "PROTOCOL_INCOMPATIBLE",
      "A pending adapter step without ranges must request a cooperative yield",
    );
  }
  if (actions.length !== 0 && cooperativeYield) {
    throw new ProtocolFault(
      "PROTOCOL_INCOMPATIBLE",
      "An adapter step cannot combine ranges with a cooperative yield",
    );
  }
  return Object.freeze({
    kind,
    operationHandle,
    operationRevision,
    actions: Object.freeze(actions),
    cooperativeYield,
    ...operationStepPayload(value),
  });
}

function operationStepPayload(value: Record<string, unknown>): Readonly<{ payload?: unknown }> {
  if (value.payload !== undefined) return Object.freeze({ payload: value.payload });
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => (
    key !== "kind"
    && key !== "operationHandle"
    && key !== "operationRevision"
    && key !== "actions"
    && key !== "cooperativeYield"
  )));
  return Object.keys(payload).length === 0
    ? Object.freeze({})
    : Object.freeze({ payload: Object.freeze(payload) });
}

function validateActionResults(
  results: readonly AdapterActionResult[],
  actions: readonly AdapterReadAction[],
): readonly AdapterActionResult[] {
  if (!Array.isArray(results) || results.length !== actions.length) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter action results are missing or unexpected");
  }
  const expected = new Map(actions.map((action) => [action.actionIndex, action]));
  const seen = new Set<number>();
  const normalized = results.map((result, position) => {
    if (!isRecord(result)) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `Adapter action result ${position} is invalid`);
    }
    const actionIndex = nonNegativeSafeInteger(result.actionIndex, "result actionIndex");
    const action = expected.get(actionIndex);
    if (!action || seen.has(actionIndex)) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter action result is duplicate or unexpected");
    }
    seen.add(actionIndex);
    const offset = nonNegativeSafeInteger(result.offset, "result offset");
    if (offset !== action.offset || !(result.bytes instanceof Uint8Array)) {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter action result does not match its range");
    }
    if (result.bytes.byteLength !== action.length || typeof result.eof !== "boolean") {
      throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", "Adapter action result has an invalid length or EOF flag");
    }
    return Object.freeze({ actionIndex, offset, bytes: result.bytes, eof: result.eof });
  });
  return Object.freeze(normalized);
}

function normalizeHandle(value: unknown, name: string): string | number {
  if (typeof value === "string" && value.length > 0) return value;
  return nonNegativeSafeInteger(value, name);
}

function positiveSafeInteger(value: unknown, name: string): number {
  const normalized = nonNegativeSafeInteger(value, name);
  if (normalized === 0) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} must be positive`);
  }
  return normalized;
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolFault("PROTOCOL_INCOMPATIBLE", `${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}
