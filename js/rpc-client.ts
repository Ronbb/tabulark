import { TabularkError, cancelledError, closedError } from "./errors.js";
import {
  PROTOCOL_VERSION,
  isRecord,
  type Operation,
  type ProtocolEvent,
  type ProtocolResponse,
  type ResponseKind,
} from "./protocol.js";

type EventListener = (event: ProtocolEvent) => void;
type FailureListener = (error: TabularkError) => void;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly expectedKind: ResponseKind;
  readonly cleanup: () => void;
}

interface RequestOptions {
  readonly transfer?: Transferable[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const RESPONSE_KINDS = new Set<ResponseKind>([
  "hello",
  "dataset",
  "tables",
  "table",
  "metadata",
  "batch",
  "acknowledged",
]);
const EVENT_NAMES = new Set([
  "progress",
  "metadata",
  "warning",
  "closed",
  "runtimeError",
]);

/** Main-thread request multiplexer for one dedicated Worker. */
export class WorkerRpcClient {
  readonly #worker: Worker;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #onEvent: EventListener;
  readonly #onFailure: FailureListener;
  #nextRequestId = 1;
  #closed = false;

  constructor(worker: Worker, onEvent: EventListener, onFailure: FailureListener = () => {}) {
    this.#worker = worker;
    this.#onEvent = onEvent;
    this.#onFailure = onFailure;
    worker.addEventListener("message", this.#handleMessage);
    worker.addEventListener("error", this.#handleWorkerFailure);
    worker.addEventListener("messageerror", this.#handleWorkerFailure);
  }

  async request<T>(
    op: Operation,
    payload: unknown,
    expectedKind: ResponseKind,
    options: RequestOptions = {},
  ): Promise<T> {
    if (this.#closed) {
      throw closedError("Engine");
    }
    if (options.signal?.aborted) {
      throw cancelledError();
    }

    const requestId = `r${this.#nextRequestId++}`;
    return new Promise<T>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      const cleanup = () => {
        for (const dispose of cleanups.splice(0)) {
          dispose();
        }
      };
      if (options.signal) {
        const abort = () => {
          const pending = this.#pending.get(requestId);
          if (!pending) {
            return;
          }
          this.#pending.delete(requestId);
          pending.cleanup();
          this.#postCancel(requestId);
          reject(cancelledError());
        };
        options.signal.addEventListener("abort", abort, { once: true });
        cleanups.push(() => options.signal?.removeEventListener("abort", abort));
      }
      if (options.timeoutMs !== undefined) {
        const timeoutMs = Math.max(1, options.timeoutMs);
        const timeoutId = globalThis.setTimeout(() => {
          if (!this.#pending.has(requestId)) {
            return;
          }
          this.#failRuntime(
            new TabularkError(
              "RUNTIME_FAILURE",
              `The Tabulark Worker did not respond to ${op} within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        cleanups.push(() => globalThis.clearTimeout(timeoutId));
      }

      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        expectedKind,
        cleanup,
      });
      try {
        this.#worker.postMessage(
          { protocolVersion: PROTOCOL_VERSION, requestId, op, payload },
          options.transfer ?? [],
        );
      } catch (error) {
        this.#pending.delete(requestId);
        cleanup();
        reject(
          new TabularkError("RUNTIME_FAILURE", "Could not send a request to the Worker", {
            cause: error,
          }),
        );
      }
    });
  }

  async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.request("shutdown", {}, "acknowledged", { timeoutMs });
    } catch {
      // Termination below is still required after a failed graceful shutdown.
    } finally {
      this.terminate();
    }
  }

  terminate(
    error = new TabularkError("RUNTIME_FAILURE", "The Tabulark Worker was terminated"),
    notifyFailure = false,
  ): void {
    if (this.#stop(error) && notifyFailure) {
      this.#notifyFailure(error);
    }
  }

  #handleMessage = (event: MessageEvent<unknown>): void => {
    const value = event.data;
    if (isValidProtocolEvent(value)) {
      try {
        this.#onEvent(value);
      } catch (error) {
        this.#failRuntime(
          new TabularkError(
            "PROTOCOL_INCOMPATIBLE",
            "The Worker emitted an invalid runtime event",
            { cause: error },
          ),
        );
      }
      return;
    }
    if (looksLikeProtocolEvent(value) || (looksLikeProtocolResponse(value) && !isValidProtocolResponse(value))) {
      this.#failRuntime(
        new TabularkError(
          "PROTOCOL_INCOMPATIBLE",
          "The Worker returned a malformed or incompatible protocol message",
        ),
      );
      return;
    }
    if (!isValidProtocolResponse(value)) {
      return;
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) {
      return;
    }
    this.#pending.delete(value.requestId);
    pending.cleanup();

    if (value.status === "failure") {
      pending.reject(TabularkError.fromSerialized(value.error));
      return;
    }
    if (value.result.kind !== pending.expectedKind) {
      const error = new TabularkError(
        "PROTOCOL_INCOMPATIBLE",
        `Expected a ${pending.expectedKind} response, received ${value.result.kind}`,
      );
      pending.reject(error);
      this.#failRuntime(error);
      return;
    }
    pending.resolve(value.result.data);
  };

  #handleWorkerFailure = (event: Event): void => {
    if (this.#closed) {
      return;
    }
    let message = "The Tabulark Worker stopped unexpectedly";
    if (typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent && event.message) {
      message = event.message;
    } else if (event.type === "messageerror") {
      message = "The Tabulark Worker could not deserialize a message";
    }
    this.#failRuntime(new TabularkError("RUNTIME_FAILURE", message));
  };

  #postCancel(targetRequestId: string): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#worker.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        requestId: `r${this.#nextRequestId++}`,
        op: "cancel",
        payload: { targetRequestId },
      });
    } catch {
      // The caller has already received its cancellation result.
    }
  }

  #failPending(error: TabularkError): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #failRuntime(error: TabularkError): void {
    if (this.#stop(error)) {
      this.#notifyFailure(error);
    }
  }

  #stop(error: TabularkError): boolean {
    if (this.#closed) {
      return false;
    }
    this.#closed = true;
    this.#worker.removeEventListener("message", this.#handleMessage);
    this.#worker.removeEventListener("error", this.#handleWorkerFailure);
    this.#worker.removeEventListener("messageerror", this.#handleWorkerFailure);
    try {
      this.#worker.terminate();
    } catch {
      // A failed Worker is already unusable; pending callers still need a terminal result.
    }
    this.#failPending(error);
    return true;
  }

  #notifyFailure(error: TabularkError): void {
    try {
      this.#onFailure(error);
    } catch {
      // The Worker is already terminal; a client callback cannot recover it.
    }
  }
}

function isValidProtocolResponse(value: unknown): value is ProtocolResponse {
  if (
    !isRecord(value)
    || value.protocolVersion !== PROTOCOL_VERSION
    || typeof value.requestId !== "string"
    || value.requestId.length === 0
  ) {
    return false;
  }
  if (value.status === "success") {
    return isRecord(value.result)
      && typeof value.result.kind === "string"
      && RESPONSE_KINDS.has(value.result.kind as ResponseKind);
  }
  if (value.status === "failure") {
    return isSerializedError(value.error);
  }
  return false;
}

function isValidProtocolEvent(value: unknown): value is ProtocolEvent {
  if (
    !isRecord(value)
    || value.protocolVersion !== PROTOCOL_VERSION
    || typeof value.event !== "string"
    || !EVENT_NAMES.has(value.event)
    || !("payload" in value)
  ) {
    return false;
  }
  if (
    !optionalNonEmptyString(value.requestId)
    || !optionalNonEmptyString(value.datasetHandle)
    || !optionalNonEmptyString(value.tableHandle)
    || !optionalNonEmptyString(value.tableId)
  ) {
    return false;
  }
  if (value.tableHandle !== undefined && value.datasetHandle === undefined) {
    return false;
  }
  if (value.event === "runtimeError") {
    return value.datasetHandle !== undefined
      || (value.tableHandle === undefined && value.tableId === undefined);
  }
  return value.datasetHandle !== undefined;
}

function isSerializedError(value: unknown): boolean {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.retryable === "boolean";
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function looksLikeProtocolResponse(value: unknown): boolean {
  return isRecord(value)
    && ("requestId" in value || "status" in value || "result" in value || "error" in value);
}

function looksLikeProtocolEvent(value: unknown): boolean {
  return isRecord(value) && "event" in value;
}
