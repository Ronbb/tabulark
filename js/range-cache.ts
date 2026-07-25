import type { RangeRequest, WireTableBatch } from "./model.js";

interface CacheEntry<T> {
  readonly value: T;
  readonly byteLength: number;
}

interface PermitWaiter {
  readonly key: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
}

export class PermitQueueFullError extends Error {
  constructor(readonly maxWaiters: number) {
    super(`The permit queue already has ${maxWaiters} waiters`);
    this.name = "PermitQueueFullError";
  }
}

/** A small FIFO permit queue whose pending acquisitions can be cancelled by key. */
export class AsyncPermitQueue {
  readonly #maxActive: number;
  readonly #maxWaiters: number;
  readonly #waiters: PermitWaiter[] = [];
  #active = 0;

  constructor(maxActive: number, maxWaiters: number) {
    if (!Number.isSafeInteger(maxActive) || maxActive <= 0) {
      throw new RangeError("maxActive must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 0) {
      throw new RangeError("maxWaiters must be a non-negative safe integer");
    }
    this.#maxActive = maxActive;
    this.#maxWaiters = maxWaiters;
  }

  acquire(key: string): Promise<() => void> {
    if (this.#active < this.#maxActive) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }
    if (this.#waiters.length >= this.#maxWaiters) {
      return Promise.reject(new PermitQueueFullError(this.#maxWaiters));
    }
    return new Promise<() => void>((resolve, reject) => {
      this.#waiters.push({ key, resolve, reject });
    });
  }

  cancel(key: string, reason: unknown): boolean {
    const index = this.#waiters.findIndex((waiter) => waiter.key === key);
    if (index < 0) {
      return false;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    waiter!.reject(reason);
    this.#wakeWaiters();
    return true;
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active -= 1;
      this.#wakeWaiters();
    };
  }

  #wakeWaiters(): void {
    while (this.#active < this.#maxActive && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      this.#active += 1;
      waiter.resolve(this.#releaseOnce());
    }
  }
}

/** A byte-bounded least-recently-used cache. */
export class ByteLruCache<T> {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, CacheEntry<T>>();
  #byteLength = 0;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, byteLength: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new RangeError("byteLength must be a non-negative safe integer");
    }
    if (byteLength > this.#maxBytes) {
      return;
    }

    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#byteLength -= existing.byteLength;
    }

    while (this.#byteLength + byteLength > this.#maxBytes) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.#entries.get(oldestKey)!;
      this.#entries.delete(oldestKey);
      this.#byteLength -= oldest.byteLength;
    }

    this.#entries.set(key, { value, byteLength });
    this.#byteLength += byteLength;
  }

  deleteWhere(predicate: (key: string, value: T) => boolean): void {
    for (const [key, entry] of this.#entries) {
      if (!predicate(key, entry.value)) {
        continue;
      }
      this.#entries.delete(key);
      this.#byteLength -= entry.byteLength;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#byteLength = 0;
  }
}

export function rangeCacheKey(
  owner: string,
  revision: number,
  schemaVersion: number,
  range: RangeRequest,
): string {
  return JSON.stringify([
    owner,
    revision,
    schemaVersion,
    range.rowStart,
    range.rowCount,
    range.columnStart,
    range.columnCount,
  ]);
}

export function rangeCacheKeyBelongsTo(key: string, owner: string): boolean {
  return key.startsWith(`[${JSON.stringify(owner)},`);
}

export function cloneWireTableBatch(batch: WireTableBatch): WireTableBatch {
  return {
    layoutVersion: batch.layoutVersion,
    tableId: batch.tableId,
    revision: batch.revision,
    schemaVersion: batch.schemaVersion,
    range: { ...batch.range },
    // Clone each pool entry exactly once. Descriptor buffer indexes remain
    // valid and native/display aliases stay deduplicated.
    buffers: batch.buffers.map((buffer) => Uint8Array.from(asUint8Array(buffer)).buffer),
    columns: batch.columns,
    complete: batch.complete,
  };
}

export function wireBatchByteLength(batch: WireTableBatch): number {
  return batch.buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
}

function asUint8Array(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
