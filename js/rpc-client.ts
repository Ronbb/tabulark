import { TabularkError, cancelledError, closedError } from "./errors.js";
import {
  PROTOCOL_VERSION,
  isProtocolEvent,
  isProtocolResponse,
  isRecord,
  type Operation,
  type ProtocolEvent,
  type ResponseKind,
} from "./protocol.js";

type EventListener = (event: ProtocolEvent) => void;
type FailureListener = (error: TabularkError) => void;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly expectedKind: ResponseKind;
  readonly abortCleanup?: () => void;
}

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
    options: { transfer?: Transferable[]; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#closed) {
      throw closedError("Engine");
    }
    if (options.signal?.aborted) {
      throw cancelledError();
    }

    const requestId = `r${this.#nextRequestId++}`;
    return new Promise<T>((resolve, reject) => {
      let abortCleanup: (() => void) | undefined;
      if (options.signal) {
        const abort = () => {
          const pending = this.#pending.get(requestId);
          if (!pending) {
            return;
          }
          this.#pending.delete(requestId);
          pending.abortCleanup?.();
          this.#postCancel(requestId);
          reject(cancelledError());
        };
        options.signal.addEventListener("abort", abort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener("abort", abort);
      }

      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        expectedKind,
        ...(abortCleanup ? { abortCleanup } : {}),
      });
      try {
        this.#worker.postMessage(
          { protocolVersion: PROTOCOL_VERSION, requestId, op, payload },
          options.transfer ?? [],
        );
      } catch (error) {
        this.#pending.delete(requestId);
        abortCleanup?.();
        reject(
          new TabularkError("RUNTIME_FAILURE", "Could not send a request to the Worker", {
            cause: error,
          }),
        );
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.request("shutdown", {}, "acknowledged");
    } catch {
      // Termination below is still required after a failed graceful shutdown.
    } finally {
      this.terminate();
    }
  }

  terminate(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#worker.removeEventListener("message", this.#handleMessage);
    this.#worker.removeEventListener("error", this.#handleWorkerFailure);
    this.#worker.removeEventListener("messageerror", this.#handleWorkerFailure);
    this.#worker.terminate();
    this.#failPending(
      new TabularkError("RUNTIME_FAILURE", "The Tabulark Worker was terminated"),
    );
  }

  #handleMessage = (event: MessageEvent<unknown>): void => {
    const value = event.data;
    if (isProtocolEvent(value)) {
      this.#onEvent(value);
      return;
    }
    if (!isProtocolResponse(value)) {
      if (isRecord(value) && typeof value.requestId === "string") {
        const pending = this.#pending.get(value.requestId);
        if (pending) {
          this.#pending.delete(value.requestId);
          pending.abortCleanup?.();
          pending.reject(
            new TabularkError(
              "PROTOCOL_INCOMPATIBLE",
              "The Worker returned a response using an incompatible protocol",
            ),
          );
        }
      }
      return;
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) {
      return;
    }
    this.#pending.delete(value.requestId);
    pending.abortCleanup?.();

    if (value.status === "failure") {
      pending.reject(TabularkError.fromSerialized(value.error));
      return;
    }
    if (value.result.kind !== pending.expectedKind) {
      pending.reject(
        new TabularkError(
          "PROTOCOL_INCOMPATIBLE",
          `Expected a ${pending.expectedKind} response, received ${value.result.kind}`,
        ),
      );
      return;
    }
    pending.resolve(value.result.data);
  };

  #handleWorkerFailure = (event: Event): void => {
    if (this.#closed) {
      return;
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
    let message = "The Tabulark Worker stopped unexpectedly";
    if (typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent && event.message) {
      message = event.message;
    } else if (event.type === "messageerror") {
      message = "The Tabulark Worker could not deserialize a message";
    }
    const error = new TabularkError("RUNTIME_FAILURE", message);
    this.#failPending(error);
    this.#onFailure(error);
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
      pending.abortCleanup?.();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
