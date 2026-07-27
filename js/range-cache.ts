import type {
  RangeRequest,
  WireTableBatch,
  WireTableBatchColumn,
} from "./model.js";

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
  readonly #maxEntries: number;
  readonly #minimumEntryBytes: number;
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #onRemove: ((key: string, value: T, byteLength: number) => void) | undefined;
  #byteLength = 0;

  constructor(
    maxBytes: number,
    options: Readonly<{
      maxEntries?: number;
      minimumEntryBytes?: number;
      onRemove?: (key: string, value: T, byteLength: number) => void;
    }> = {},
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }
    const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError("maxEntries must be a non-negative safe integer");
    }
    const minimumEntryBytes = options.minimumEntryBytes ?? 0;
    if (!Number.isSafeInteger(minimumEntryBytes) || minimumEntryBytes < 0) {
      throw new RangeError("minimumEntryBytes must be a non-negative safe integer");
    }
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
    this.#minimumEntryBytes = minimumEntryBytes;
    this.#onRemove = options.onRemove;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  get maxEntries(): number {
    return this.#maxEntries;
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

  set(key: string, value: T, byteLength: number, maxBytes = this.#maxBytes): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new RangeError("byteLength must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }
    const effectiveMaxBytes = Math.min(this.#maxBytes, maxBytes);
    const chargedBytes = Math.max(byteLength, this.#minimumEntryBytes);
    if (chargedBytes > effectiveMaxBytes || this.#maxEntries === 0) {
      return;
    }

    const existing = this.#entries.get(key);
    if (existing) {
      this.#remove(key, existing);
    }

    while (
      this.#entries.size >= this.#maxEntries
      || this.#byteLength + chargedBytes > effectiveMaxBytes
    ) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.#entries.get(oldestKey)!;
      this.#remove(oldestKey, oldest);
    }

    this.#entries.set(key, { value, byteLength: chargedBytes });
    this.#byteLength += chargedBytes;
  }

  /** Evicts least-recently-used entries until the requested live cap is met. */
  trimTo(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }
    const effectiveMaxBytes = Math.min(this.#maxBytes, maxBytes);
    while (this.#byteLength > effectiveMaxBytes) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#entries.get(oldestKey)!;
      this.#remove(oldestKey, oldest);
    }
  }

  deleteWhere(predicate: (key: string, value: T) => boolean): void {
    for (const [key, entry] of this.#entries) {
      if (!predicate(key, entry.value)) {
        continue;
      }
      this.#remove(key, entry);
    }
  }

  clear(): void {
    for (const [key, entry] of this.#entries) {
      this.#onRemove?.(key, entry.value, entry.byteLength);
    }
    this.#entries.clear();
    this.#byteLength = 0;
  }

  #remove(key: string, entry: CacheEntry<T>): void {
    this.#entries.delete(key);
    this.#byteLength -= entry.byteLength;
    this.#onRemove?.(key, entry.value, entry.byteLength);
  }
}

export function rangeCacheKey(
  datasetHandle: string,
  tableId: string,
  revision: number,
  schemaVersion: number,
  range: RangeRequest,
): string {
  return JSON.stringify([
    datasetHandle,
    tableId,
    revision,
    schemaVersion,
    range.rowStart,
    range.rowCount,
    range.columnStart,
    range.columnCount,
  ]);
}

export function rangeCacheKeyBelongsToDataset(key: string, datasetHandle: string): boolean {
  return key.startsWith(`[${JSON.stringify(datasetHandle)},`);
}

export function rangeCacheKeyBelongsToTable(
  key: string,
  datasetHandle: string,
  tableId: string,
): boolean {
  return key.startsWith(
    `[${JSON.stringify(datasetHandle)},${JSON.stringify(tableId)},`,
  );
}

export function rangeCacheKeyMatchesVersion(
  key: string,
  revision: number,
  schemaVersion: number,
): boolean {
  try {
    const fields = JSON.parse(key) as unknown;
    return Array.isArray(fields)
      && fields.length === 8
      && fields[2] === revision
      && fields[3] === schemaVersion;
  } catch {
    return false;
  }
}

/**
 * Main-thread-owned immutable backing for a logical batch.
 *
 * The ArrayBuffers arrive as independently transferable Worker output and are
 * intentionally not cloned here. They remain unreachable through the public
 * batch facade; binary getters perform their own defensive copy.
 */
export type BatchBacking = Omit<WireTableBatch, "buffers" | "columns" | "range"> & Readonly<{
  range: Readonly<WireTableBatch["range"]>;
  buffers: readonly ArrayBuffer[];
  columns: readonly WireTableBatchColumn[];
}>;

export function createBatchBacking(batch: WireTableBatch): BatchBacking {
  const buffers = batch.buffers.map((buffer, index) => {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError(`Transferred batch buffer ${index} must own an ArrayBuffer backing`);
    }
    return buffer;
  });
  const columns = batch.columns.map((column) => freezeBatchDescriptor(column));
  return Object.freeze({
    layoutVersion: batch.layoutVersion,
    tableId: batch.tableId,
    revision: batch.revision,
    schemaVersion: batch.schemaVersion,
    range: Object.freeze({ ...batch.range }),
    buffers: Object.freeze(buffers),
    columns: Object.freeze(columns),
    complete: batch.complete,
  });
}

export function wireBatchByteLength(batch: WireTableBatch): number {
  return batch.buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
}

function freezeBatchDescriptor<T extends object>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null || seen.has(entry)) {
      return;
    }
    // Buffer contents are owned by the backing and deliberately remain
    // readable by the logical facade. Freezing a non-empty typed array also
    // throws in current engines, so only descriptor objects are traversed.
    if (entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) {
      return;
    }
    seen.add(entry);
    for (const child of Object.values(entry)) {
      freeze(child);
    }
    Object.freeze(entry);
  };
  freeze(value);
  return value;
}
