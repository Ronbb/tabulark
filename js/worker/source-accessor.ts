import { ProtocolFault } from "./worker-errors.js";
import { MAX_RANGE_SOURCE_BYTES } from "../range-source.js";

/** The largest source address representable by the wasm32 adapter boundary. */
export { MAX_RANGE_SOURCE_BYTES };

/** A cancellation hook understood by the worker source broker. */
export interface SourceReadOptions {
  /** Resolves when the owning operation is cancelled. */
  readonly cancellation?: Promise<void>;
  /** Records one actual provider/Blob read after exact-length validation. */
  readonly onProviderRead?: (bytes: number) => void;
  /** Records bytes served without another provider read. */
  readonly onCacheHit?: (bytes: number) => void;
  /** Internal lifetime hook fired when the underlying read settles. */
  readonly onSettled?: () => void;
}

export interface SourceAccessor {
  readonly kind: "blob" | "range";
  readonly size: number;
  read(offset: number, length: number, options?: SourceReadOptions): Promise<ArrayBuffer>;
  readMany?(
    requests: readonly Readonly<{ readonly offset: number; readonly end: number }>[],
    options?: SourceReadOptions,
  ): Promise<readonly ArrayBuffer[]>;
  /** Releases provider state and all retained range bytes. Idempotent. */
  close(): void;
}

interface BrokerSourceDescriptor {
  readonly kind: "range";
  readonly handle: string;
  readonly size: number;
  readonly maxConcurrency?: number;
}

interface SourceReadRequest {
  readonly type: "source-read";
  readonly requestId: string;
  readonly sourceHandle: string;
  readonly offset: number;
  readonly length: number;
}

interface PendingBrokerRead {
  readonly requestId: string;
  readonly sourceHandle: string;
  readonly offset: number;
  readonly length: number;
  readonly resolve: (value: ArrayBuffer) => void;
  readonly reject: (reason: unknown) => void;
}

interface CachedRange {
  readonly offset: number;
  readonly end: number;
  readonly bytes: ArrayBuffer;
  lastUsed: number;
}

interface PendingRange {
  readonly offset: number;
  readonly end: number;
  promise: Promise<RangeCoverage>;
  readonly cancellation: RequestCancellation;
  waiters: number;
  settled: boolean;
  coverage?: RangeCoverage;
}

interface RangeCoverage {
  readonly offset: number;
  readonly end: number;
  readonly bytes: ArrayBuffer;
}

interface RequestCancellation {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface ProviderPermitWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly cancellation: Promise<void>;
  cancelled: boolean;
  granted: boolean;
}

interface ReadInterval {
  readonly offset: number;
  readonly end: number;
}

/**
 * The host-side half of the private Worker source broker.
 *
 * The host never gives callbacks to the Worker. It receives a small request
 * DTO and sends back one transferable buffer, which keeps network/fetch state
 * and credentials entirely on the main thread.
 */
export class WorkerSourceBroker {
  readonly #scope: DedicatedWorkerGlobalScope;
  readonly #pending = new Map<string, PendingBrokerRead>();
  #nextRequestId = 1;
  #closed = false;

  constructor(scope: DedicatedWorkerGlobalScope) {
    this.#scope = scope;
  }

  request(
    sourceHandle: string,
    offset: number,
    length: number,
    options: SourceReadOptions = {},
  ): Promise<ArrayBuffer> {
    if (typeof sourceHandle !== "string" || sourceHandle.length === 0
      || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(length) || length < 0
      || offset > MAX_RANGE_SOURCE_BYTES
      || length > MAX_RANGE_SOURCE_BYTES
      || offset + length > MAX_RANGE_SOURCE_BYTES) {
      return Promise.reject(new ProtocolFault("RANGE_UNSUPPORTED", "The source range is invalid"));
    }
    if (this.#closed) {
      return Promise.reject(new ProtocolFault("HANDLE_CLOSED", "The source broker is closed"));
    }
    const requestId = `s${this.#nextRequestId++}`;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const pending: PendingBrokerRead = {
        requestId,
        sourceHandle,
        offset,
        length,
        resolve,
        reject,
      };
      this.#pending.set(requestId, pending);
      let cancelled = false;
      const cancel = (): void => {
        if (cancelled || this.#pending.get(requestId) !== pending) return;
        cancelled = true;
        this.#pending.delete(requestId);
        this.#postCancel(requestId, sourceHandle);
        reject(new ProtocolFault("CANCELLED", "The source read was cancelled"));
      };
      if (options.cancellation) {
        options.cancellation.then(cancel, cancel);
      }
      try {
        const message: SourceReadRequest = {
          type: "source-read",
          requestId,
          sourceHandle,
          offset,
          length,
        };
        this.#scope.postMessage(message);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(new ProtocolFault(
          "SOURCE_UNAVAILABLE",
          "The source provider could not receive a range request",
          true,
          undefined,
          error,
        ));
      }
    });
  }

  /** Handles a message delivered from the main-thread broker. */
  handle(value: unknown): boolean {
    if (!isRecord(value) || (
      value.type !== "source-read-result"
      && value.type !== "source-read-failure"
      && value.type !== "source-read-error"
    )) {
      return false;
    }
    if (typeof value.requestId !== "string") return true;
    const pending = this.#pending.get(value.requestId);
    if (!pending) return true;
    this.#pending.delete(value.requestId);
    if (
      value.sourceHandle !== pending.sourceHandle
      || value.offset !== pending.offset
      || value.length !== pending.length
    ) {
      this.#postCancel(pending.requestId, pending.sourceHandle);
      pending.reject(new ProtocolFault(
        "PROTOCOL_INCOMPATIBLE",
        "The source provider returned a range for another request",
      ));
      return true;
    }
    if (value.type !== "source-read-result" || value.error !== undefined || value.ok === false) {
      pending.reject(sourceFailure(value.error));
      return true;
    }
    try {
      pending.resolve(normalizeExactBytes(value.buffer, pending.length));
    } catch (error) {
      pending.reject(error instanceof ProtocolFault
        ? error
        : new ProtocolFault("RUNTIME_FAILURE", "The source provider returned invalid bytes", false, undefined, error));
    }
    return true;
  }

  close(sourceHandle: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.sourceHandle !== sourceHandle) continue;
      this.#pending.delete(requestId);
      this.#postCancel(requestId, sourceHandle);
      pending.reject(new ProtocolFault("HANDLE_CLOSED", "The source was closed"));
    }
    if (this.#closed) return;
    try {
      this.#scope.postMessage({ type: "source-close", sourceHandle });
    } catch {
      // Closing a failed Worker is best effort.
    }
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      this.#postCancel(pending.requestId, pending.sourceHandle);
      pending.reject(new ProtocolFault("HANDLE_CLOSED", "The source broker was shut down"));
    }
    this.#pending.clear();
  }

  #postCancel(requestId: string, sourceHandle: string): void {
    try {
      this.#scope.postMessage({
        type: "source-read-cancel",
        requestId,
        sourceHandle,
      });
    } catch {
      // The Worker may already be terminating; the local rejection remains
      // authoritative and prevents a late provider response from being used.
    }
  }
}

/** A local Blob/File accessor. Blob.slice remains the only source operation. */
export class BlobSourceAccessor implements SourceAccessor {
  readonly kind = "blob" as const;
  readonly size: number;
  readonly #blob: Blob;
  #closed = false;

  constructor(blob: Blob) {
    this.#blob = blob;
    this.size = blob.size;
  }

  async read(offset: number, length: number, options: SourceReadOptions = {}): Promise<ArrayBuffer> {
    if (this.#closed) {
      options.onSettled?.();
      throw new ProtocolFault("HANDLE_CLOSED", "The source is closed");
    }
    const end = checkedEnd(offset, length, this.size);
    if (end === undefined) {
      options.onSettled?.();
      throw new ProtocolFault("RANGE_UNSUPPORTED", "The requested source range is outside the source");
    }
    let bounded: Blob;
    try {
      bounded = this.#blob.slice(offset, end);
      if (!bounded || (bounded.size !== undefined && bounded.size !== length)) {
        throw new ProtocolFault("RUNTIME_FAILURE", "Blob slice returned an invalid bounded length");
      }
    } catch (error) {
      options.onSettled?.();
      throw error instanceof ProtocolFault
        ? error
        : new ProtocolFault("SOURCE_UNAVAILABLE", "The local source could not be sliced", true, undefined, error);
    }
    const operation = readBlob(bounded, length).finally(() => options.onSettled?.());
    const result = options.cancellation === undefined
      ? await operation
      : await raceCancellation(operation, options.cancellation);
    options.onProviderRead?.(result.byteLength);
    return result;
  }

  close(): void {
    this.#closed = true;
  }
}

/**
 * A remote range accessor. The interval cache is deliberately scoped to this
 * accessor, which is one reader/dataset, so closing the dataset drops all
 * retained bytes and pending singleflight state.
 */
export class RangeSourceAccessor implements SourceAccessor {
  readonly kind = "range" as const;
  readonly size: number;
  readonly #broker: WorkerSourceBroker;
  readonly #sourceHandle: string;
  readonly #maxCacheBytes: number;
  readonly #maxReadBytes: number;
  readonly #maxConcurrency: number;
  readonly #cache: CachedRange[] = [];
  readonly #inflight: PendingRange[] = [];
  readonly #providerQueue: ProviderPermitWaiter[] = [];
  #providerReads = 0;
  #cacheBytes = 0;
  #clock = 0;
  #closed = false;

  constructor(
    descriptor: BrokerSourceDescriptor,
    broker: WorkerSourceBroker,
    maxCacheBytes: number,
    maxReadBytes: number,
  ) {
    validateRangeDescriptor(descriptor);
    this.size = descriptor.size;
    this.#sourceHandle = descriptor.handle;
    this.#broker = broker;
    this.#maxConcurrency = descriptor.maxConcurrency === undefined
      ? 1
      : descriptor.maxConcurrency;
    this.#maxCacheBytes = Number.isSafeInteger(maxCacheBytes) && maxCacheBytes > 0
      ? maxCacheBytes
      : 0;
    this.#maxReadBytes = Number.isSafeInteger(maxReadBytes) && maxReadBytes > 0
      ? maxReadBytes
      : 1;
  }

  async read(offset: number, length: number, options: SourceReadOptions = {}): Promise<ArrayBuffer> {
    try {
      return await this.#readInternal(offset, length, options);
    } finally {
      options.onSettled?.();
    }
  }

  async #readInternal(offset: number, length: number, options: SourceReadOptions = {}): Promise<ArrayBuffer> {
    const end = checkedEnd(offset, length, this.size);
    if (end === undefined) {
      throw new ProtocolFault("RANGE_UNSUPPORTED", "The requested source range is outside the source");
    }
    if (this.#closed) throw new ProtocolFault("HANDLE_CLOSED", "The source is closed");
    if (length === 0) return new ArrayBuffer(0);

    // Snapshot LRU coverage before attaching to concurrent provider work.
    // Bytes inserted when an in-flight singleflight settles are deduplicated
    // work, not cache hits for this caller, even though they enter the LRU
    // before the shared promise resumes.
    let unreportedCacheHitBytes = this.#coveredLength(offset, end);
    const reportInitialCacheHit = (): void => {
      if (unreportedCacheHitBytes > 0) options.onCacheHit?.(unreportedCacheHitBytes);
      unreportedCacheHitBytes = 0;
    };

    // A merged step may span several adapter actions. Keep every host-side
    // broker response within the staging slice supplied at open time while
    // still returning one exact contiguous result to the adapter.
    if (length > this.#maxReadBytes) {
      const chunks: ArrayBuffer[] = [];
      let cursor = offset;
      while (cursor < end) {
        const chunkEnd = Math.min(end, cursor + this.#maxReadBytes);
        chunks.push(await this.#readInternal(cursor, chunkEnd - cursor, options));
        cursor = chunkEnd;
      }
      const output = new Uint8Array(length);
      let target = 0;
      for (const chunk of chunks) {
        output.set(new Uint8Array(chunk), target);
        target += chunk.byteLength;
      }
      return output.buffer;
    }

    // Keep successful overlapping singleflight coverage as an ephemeral
    // segment even when the byte LRU cannot retain the whole request. This
    // prevents a large concurrent request from issuing a second provider read
    // merely because its first result was larger than the cache budget.
    const inherited: RangeCoverage[] = [];

    // Wait for overlapping in-flight work before computing the missing part.
    // This is the dataset-level singleflight path: identical and overlapping
    // concurrent requests share one provider read whenever possible.
    for (;;) {
      if (this.#closed) throw new ProtocolFault("HANDLE_CLOSED", "The source is closed");
      const cached = this.#assemble(offset, end, inherited);
      if (cached) {
        reportInitialCacheHit();
        return cached;
      }
      const overlap = this.#inflight.filter((entry) => (
        entry.waiters > 0 && entry.offset < end && entry.end > offset
      ));
      if (overlap.length > 0) {
        for (const entry of overlap) entry.waiters += 1;
        let sharedCoverage: readonly RangeCoverage[] = [];
        try {
          sharedCoverage = await raceCancellation(
            Promise.all(overlap.map((entry) => entry.promise)),
            options.cancellation,
          );
        } finally {
          for (const entry of overlap) this.#releasePendingWaiter(entry);
        }
        inherited.push(...sharedCoverage);
        const shared = this.#assemble(offset, end, inherited);
        if (shared !== undefined) {
          reportInitialCacheHit();
          return shared;
        }
        continue;
      }

      // Do not attach one caller's cancellation to the shared provider work:
      // another table operation may still be waiting on this interval. Each
      // caller races the shared promise independently below.
      reportInitialCacheHit();
      const pending: PendingRange = {
        offset,
        end,
        promise: Promise.resolve({ offset, end, bytes: new ArrayBuffer(0) }),
        cancellation: createRequestCancellation(),
        waiters: 1,
        settled: false,
      };
      const promise = this.#fetchMissing(
        offset,
        end,
        pending.cancellation.promise,
        options.onProviderRead,
        inherited,
      );
      pending.promise = promise;
      this.#inflight.push(pending);
      void promise.then(
        (coverage) => {
          pending.coverage = coverage;
          this.#settlePending(pending);
        },
        () => this.#settlePending(pending),
      );
      let coverage: RangeCoverage;
      try {
        coverage = await raceCancellation(promise, options.cancellation);
      } finally {
        this.#releasePendingWaiter(pending);
      }
      // A response may be larger than the byte LRU. Use the pending coverage
      // as the exact result even when it was intentionally not retained.
      // Provider/cache coverage is immutable inside the official adapter
      // runtime. Sharing the owned buffer keeps singleflight from allocating
      // one extra full-range copy per waiter.
      return coverage.bytes;
    }
  }

  /** Reads a step's actions after merging overlaps and direct adjacency. */
  async readMany(
    requests: readonly ReadInterval[],
    options: SourceReadOptions = {},
  ): Promise<readonly ArrayBuffer[]> {
    if (requests.length === 0) return Object.freeze([]);
    const normalized = requests.map((request) => {
      const end = checkedEnd(request.offset, request.end - request.offset, this.size);
      if (end === undefined) {
        throw new ProtocolFault("RANGE_UNSUPPORTED", "The requested source range is outside the source");
      }
      return { offset: request.offset, end };
    });
    const merged = mergeIntervals(normalized).flatMap((interval) => splitInterval(interval, this.#maxReadBytes));
    // Resolve merged intervals in at most four concurrent provider reads. Keep
    // the exact returned coverage separately because the LRU may evict a large
    // merged span immediately after it is fetched.
    const fetched: RangeCoverage[] = [];
    await runBounded(merged, this.#maxConcurrency, async (interval) => {
      const bytes = await this.read(interval.offset, interval.end - interval.offset, options);
      fetched.push({ offset: interval.offset, end: interval.end, bytes });
    });
    return Object.freeze(normalized.map((interval) => {
      if (interval.offset === interval.end) return new ArrayBuffer(0);
      const bytes = this.#assemble(interval.offset, interval.end, fetched);
      if (!bytes) {
        throw new ProtocolFault("SOURCE_UNAVAILABLE", "The source provider returned no bytes", true);
      }
      return bytes;
    }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cache.length = 0;
    this.#cacheBytes = 0;
    for (const pending of this.#inflight) {
      pending.waiters = 0;
      pending.cancellation.resolve();
    }
    // Drop the accessor's references immediately. The provider promises may
    // still settle later (after honoring cancellation), but their callbacks
    // no longer keep source coverage or waiter state alive after close.
    this.#inflight.length = 0;
    for (const waiter of this.#providerQueue.splice(0)) {
      waiter.cancelled = true;
      waiter.reject(new ProtocolFault("HANDLE_CLOSED", "The source is closed"));
    }
    this.#broker.close(this.#sourceHandle);
  }

  async #acquireProviderPermit(cancellation: Promise<void>): Promise<() => void> {
    if (this.#closed) throw new ProtocolFault("HANDLE_CLOSED", "The source is closed");
    if (this.#providerReads < this.#maxConcurrency) {
      this.#providerReads += 1;
      return () => this.#releaseProviderPermit();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: ProviderPermitWaiter = {
        resolve,
        reject,
        cancellation,
        cancelled: false,
        granted: false,
      };
      const onCancel = (): void => {
        if (waiter.cancelled || waiter.granted) return;
        waiter.cancelled = true;
        const index = this.#providerQueue.indexOf(waiter);
        if (index >= 0) this.#providerQueue.splice(index, 1);
        reject(new ProtocolFault("CANCELLED", "The source read was cancelled"));
      };
      cancellation.then(onCancel, onCancel);
      this.#providerQueue.push(waiter);
    });
  }

  #releaseProviderPermit(): void {
    this.#providerReads = Math.max(0, this.#providerReads - 1);
    while (this.#providerQueue.length > 0) {
      const waiter = this.#providerQueue.shift()!;
      if (waiter.cancelled) continue;
      if (this.#closed) {
        waiter.cancelled = true;
        waiter.reject(new ProtocolFault("HANDLE_CLOSED", "The source is closed"));
        continue;
      }
      this.#providerReads += 1;
      waiter.granted = true;
      waiter.resolve(() => this.#releaseProviderPermit());
      return;
    }
  }

  async #fetchMissing(
    offset: number,
    end: number,
    cancellation: Promise<void>,
    onProviderRead?: (bytes: number) => void,
    inherited: readonly RangeCoverage[] = [],
  ): Promise<RangeCoverage> {
    // Another interval can have completed between the first check and the
    // insertion into #inflight. Recompute holes and fetch only uncovered ones.
    const holes = this.#missing(offset, end, inherited);
    const fetched: RangeCoverage[] = [];
    await runBounded(holes, this.#maxConcurrency, async (hole) => {
      const release = await this.#acquireProviderPermit(cancellation);
      let buffer: ArrayBuffer;
      try {
        buffer = await this.#broker.request(
          this.#sourceHandle,
          hole.offset,
          hole.end - hole.offset,
          { cancellation },
        );
      } finally {
        release();
      }
      onProviderRead?.(buffer.byteLength);
      if (this.#closed) throw new ProtocolFault("HANDLE_CLOSED", "The source is closed");
      fetched.push({ offset: hole.offset, end: hole.end, bytes: buffer });
      this.#insert(hole.offset, buffer);
    });
    const exactFetched = inherited.length === 0
      && fetched.length === 1
      && fetched[0]!.offset === offset
      && fetched[0]!.end === end
      ? fetched[0]!.bytes
      : undefined;
    const bytes = exactFetched ?? this.#assemble(offset, end, [...inherited, ...fetched]);
    if (bytes === undefined) {
      throw new ProtocolFault("SOURCE_UNAVAILABLE", "The source provider returned no bytes", true);
    }
    return { offset, end, bytes };
  }

  #missing(
    offset: number,
    end: number,
    extra: readonly RangeCoverage[] = [],
  ): ReadInterval[] {
    const covered = this.#cache
      .filter((entry) => entry.end > offset && entry.offset < end)
      .map((entry) => ({ offset: Math.max(offset, entry.offset), end: Math.min(end, entry.end) }))
      .concat(extra
        .filter((entry) => entry.end > offset && entry.offset < end)
        .map((entry) => ({ offset: Math.max(offset, entry.offset), end: Math.min(end, entry.end) })))
      .sort((a, b) => a.offset - b.offset || a.end - b.end);
    const holes: ReadInterval[] = [];
    let cursor = offset;
    for (const entry of covered) {
      if (entry.end <= cursor) continue;
      if (entry.offset > cursor) holes.push({ offset: cursor, end: entry.offset });
      cursor = Math.max(cursor, entry.end);
      if (cursor >= end) break;
    }
    if (cursor < end) holes.push({ offset: cursor, end });
    return holes;
  }

  #covered(offset: number, end: number): ArrayBuffer | undefined {
    return this.#assemble(offset, end, []);
  }

  #assemble(
    offset: number,
    end: number,
    extra: readonly RangeCoverage[],
  ): ArrayBuffer | undefined {
    if (end === offset) return new ArrayBuffer(0);
    const segments: RangeCoverage[] = [];
    for (const entry of this.#cache) {
      if (entry.end <= offset || entry.offset >= end) continue;
      entry.lastUsed = ++this.#clock;
      segments.push({ offset: entry.offset, end: entry.end, bytes: entry.bytes });
    }
    for (const entry of extra) {
      if (entry.end > offset && entry.offset < end) segments.push(entry);
    }
    segments.sort((left, right) => left.offset - right.offset || left.end - right.end);
    const output = new Uint8Array(end - offset);
    let cursor = offset;
    for (const segment of segments) {
      if (segment.end <= cursor) continue;
      if (segment.offset > cursor) return undefined;
      const start = Math.max(cursor, segment.offset);
      const segmentEnd = Math.min(end, segment.end);
      const sourceStart = start - segment.offset;
      const length = segmentEnd - start;
      output.set(new Uint8Array(segment.bytes, sourceStart, length), start - offset);
      cursor = segmentEnd;
      if (cursor >= end) break;
    }
    return cursor >= end ? output.buffer : undefined;
  }

  #coveredLength(
    offset: number,
    end: number,
    extra: readonly RangeCoverage[] = [],
  ): number {
    const covered = this.#cache
      .filter((entry) => entry.end > offset && entry.offset < end)
      .map((entry) => ({ offset: Math.max(offset, entry.offset), end: Math.min(end, entry.end) }))
      .concat(extra
        .filter((entry) => entry.end > offset && entry.offset < end)
        .map((entry) => ({ offset: Math.max(offset, entry.offset), end: Math.min(end, entry.end) })))
      .sort((a, b) => a.offset - b.offset || a.end - b.end);
    let bytes = 0;
    let cursor = offset;
    for (const entry of covered) {
      const start = Math.max(cursor, entry.offset);
      if (entry.end <= start) continue;
      bytes += entry.end - start;
      cursor = entry.end;
      if (cursor >= end) break;
    }
    return bytes;
  }

  #insert(offset: number, bytes: ArrayBuffer): void {
    const length = bytes.byteLength;
    if (length === 0 || this.#maxCacheBytes <= 0 || length > this.#maxCacheBytes) return;
    const end = offset + length;
    // Keep disjoint bounded entries instead of constructing an oversized
    // merged allocation when adjacent cached windows touch. Coverage assembly
    // below handles overlap/adjacency and the byte LRU remains a hard cap.
    const entry: CachedRange = {
      offset,
      end,
      // Broker buffers are transferred into this Worker and treated as
      // immutable by official adapters, so the LRU can retain the owned
      // allocation directly instead of momentarily doubling cache usage.
      bytes,
      lastUsed: ++this.#clock,
    };
    this.#cache.push(entry);
    this.#cacheBytes += entry.bytes.byteLength;
    while (this.#cacheBytes > this.#maxCacheBytes && this.#cache.length > 0) {
      let oldest = this.#cache[0]!;
      for (const candidate of this.#cache) {
        if (candidate.lastUsed < oldest.lastUsed) oldest = candidate;
      }
      this.#remove(oldest);
    }
  }

  #remove(entry: CachedRange): void {
    const index = this.#cache.indexOf(entry);
    if (index < 0) return;
    this.#cache.splice(index, 1);
    this.#cacheBytes -= entry.bytes.byteLength;
  }

  #settlePending(entry: PendingRange): void {
    entry.settled = true;
    if (entry.waiters === 0) this.#removePending(entry);
  }

  #releasePendingWaiter(entry: PendingRange): void {
    if (entry.waiters > 0) entry.waiters -= 1;
    if (entry.waiters === 0 && !entry.settled) {
      entry.cancellation.resolve();
    } else if (entry.waiters === 0) {
      this.#removePending(entry);
    }
  }

  #removePending(entry: PendingRange): void {
    const index = this.#inflight.indexOf(entry);
    if (index >= 0) this.#inflight.splice(index, 1);
  }
}

export function validateRangeDescriptor(value: unknown): asserts value is BrokerSourceDescriptor {
  if (!isRecord(value) || value.kind !== "range") {
    throw new ProtocolFault("INVALID_ARGUMENT", "source must be a range descriptor");
  }
  if (Object.keys(value).some((key) => (
    key !== "kind" && key !== "handle" && key !== "size" && key !== "maxConcurrency"
  ))) {
    throw new ProtocolFault("INVALID_ARGUMENT", "range source descriptor contains private fields");
  }
  const handle = value.handle;
  const size = value.size;
  if (typeof handle !== "string" || handle.length === 0 || handle.length > 256) {
    throw new ProtocolFault("INVALID_ARGUMENT", "range source handle must be a non-empty string");
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RANGE_SOURCE_BYTES) {
    throw new ProtocolFault(
      "RESOURCE_LIMIT",
      `Range sources support at most ${MAX_RANGE_SOURCE_BYTES} bytes`,
      false,
      { resource: "source-staging", requiredBytes: numberForDetails(size), availableBytes: MAX_RANGE_SOURCE_BYTES },
    );
  }
  if (value.maxConcurrency !== undefined
    && (!Number.isSafeInteger(value.maxConcurrency)
      || value.maxConcurrency < 1
      || value.maxConcurrency > 4)) {
    throw new ProtocolFault("INVALID_ARGUMENT", "range source maxConcurrency must be between 1 and 4");
  }
}

function sourceFailure(value: unknown): ProtocolFault {
  if (isRecord(value) && typeof value.code === "string") {
    const code = value.code === "SOURCE_CHANGED"
      || value.code === "SOURCE_UNAVAILABLE"
      || value.code === "RANGE_UNSUPPORTED"
      || value.code === "RUNTIME_FAILURE"
      || value.code === "RESOURCE_LIMIT"
      || value.code === "CANCELLED"
      || value.code === "HANDLE_CLOSED"
      ? value.code
      : "SOURCE_UNAVAILABLE";
    // Provider text can contain a URL, query, validator, or header. Keep the
    // Worker error deliberately generic; diagnostics must remain path-free.
    const message = sourceFailureMessage(code);
    return new ProtocolFault(
      code,
      message,
      value.retryable === true,
      code === "RESOURCE_LIMIT" ? safeLimitDetails(value.details) : undefined,
    );
  }
  return new ProtocolFault("SOURCE_UNAVAILABLE", "The source provider failed to read bytes", true);
}

function sourceFailureMessage(code: string): string {
  switch (code) {
    case "SOURCE_CHANGED": return "The source changed while it was open";
    case "RANGE_UNSUPPORTED": return "The source does not support the requested byte range";
    case "RUNTIME_FAILURE": return "The source provider returned invalid bytes";
    case "RESOURCE_LIMIT": return "The source exceeds its configured limit";
    case "HANDLE_CLOSED": return "The source is closed";
    case "CANCELLED": return "The source read was cancelled";
    default: return "The source provider is unavailable";
  }
}

function safeLimitDetails(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return { resource: "source-staging", requiredBytes: 0, availableBytes: 0 };
  return {
    resource: typeof value.resource === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value.resource)
      ? value.resource
      : "source-staging",
    requiredBytes: numberForDetails(value.requiredBytes),
    availableBytes: numberForDetails(value.availableBytes),
  };
}

function normalizeExactBytes(value: unknown, expectedLength: number): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength !== expectedLength) {
      throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned an invalid byte length");
    }
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength !== expectedLength) {
      throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned an invalid byte length");
    }
    const bytes = new Uint8Array(expectedLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return bytes.buffer;
  }
  throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned no byte buffer");
}

async function readBlob(blob: Blob, expectedLength: number): Promise<ArrayBuffer> {
  try {
    const method = (blob as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
    const result = typeof method === "function"
      ? await method.call(blob)
      : await readBlobStream(blob, expectedLength);
    return normalizeExactBytes(result, expectedLength);
  } catch (error) {
    if (error instanceof ProtocolFault) throw error;
    throw new ProtocolFault("SOURCE_UNAVAILABLE", "The local source could not be read", true, undefined, error);
  }
}

async function readBlobStream(blob: Blob, expectedLength: number): Promise<ArrayBuffer> {
  if (typeof blob.stream !== "function") {
    throw new TypeError("Blob slices must provide stream() or arrayBuffer()");
  }
  const output = new Uint8Array(expectedLength);
  const reader = blob.stream().getReader();
  let written = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array
        ? next.value
        : new Uint8Array(next.value as ArrayBufferLike);
      if (chunk.byteLength > expectedLength - written) {
        throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned too many bytes");
      }
      output.set(chunk, written);
      written += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (written !== expectedLength) {
    throw new ProtocolFault("RUNTIME_FAILURE", "The source provider returned too few bytes");
  }
  return output.buffer;
}

function checkedEnd(offset: number, length: number, size: number): number | undefined {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || !Number.isSafeInteger(size) || size < 0
    || offset > size || length > size - offset) return undefined;
  return offset + length;
}

function mergeIntervals(intervals: readonly ReadInterval[]): ReadInterval[] {
  const sorted = [...intervals].sort((a, b) => a.offset - b.offset || a.end - b.end);
  const merged: ReadInterval[] = [];
  for (const current of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && current.offset <= previous.end) {
      if (current.end > previous.end) {
        merged[merged.length - 1] = { offset: previous.offset, end: current.end };
      }
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function splitInterval(interval: ReadInterval, maxBytes: number): ReadInterval[] {
  if (interval.end <= interval.offset) return [{ ...interval }];
  const result: ReadInterval[] = [];
  let cursor = interval.offset;
  while (cursor < interval.end) {
    const end = Math.min(interval.end, cursor + maxBytes);
    result.push({ offset: cursor, end });
    cursor = end;
  }
  return result;
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= values.length) return;
      try {
        await task(values[index]!);
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
        // Drain the remaining work items so every provider promise settles
        // before the caller releases its operation reservation.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failed) throw firstError;
}

function raceCancellation<T>(operation: Promise<T>, cancellation?: Promise<void>): Promise<T> {
  if (!cancellation) return operation;
  return Promise.race([
    operation,
    cancellation.then<T>(() => {
      throw new ProtocolFault("CANCELLED", "The source read was cancelled");
    }),
  ]);
}

function createRequestCancellation(): RequestCancellation {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function numberForDetails(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
