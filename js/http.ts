import {
  TabularkError,
  cancelledError,
  closedError,
  invalidArgument,
} from "./errors.js";
import {
  MAX_RANGE_SOURCE_BYTES,
  copyRangeBytes,
  isSafeNonNegativeInteger,
  validateByteRange,
  type ByteRange,
  type RangeSource,
  type RangeSourceOpenOptions,
  type RangeSourceReader,
  type RangeSourceSnapshot,
} from "./range-source.js";

/** The phase in which dynamic request headers are evaluated. */
export type HttpHeaderPhase = "probe" | "read";

export interface HttpHeaderContext {
  readonly phase: HttpHeaderPhase;
  readonly range?: ByteRange;
  readonly signal: AbortSignal;
}

/** Static headers or a per-request (for example, rotating-auth) provider. */
export type HttpHeaders = HeadersInit | ((context: HttpHeaderContext) =>
  HeadersInit | Promise<HeadersInit>);

export interface BoundedDownloadFallback {
  readonly mode: "bounded-download";
  /** Maximum full-response bytes the caller explicitly permits. */
  readonly maxBytes: number;
}

export type HttpValidationStrength = "strong" | "weak" | "etag" | "last-modified";

/** Optional retry spelling accepted by the HTTP helper. */
export interface HttpRetryOptions {
  /** Total attempts, including the first request. */
  readonly maxAttempts?: number;
  /** Alias for maxAttempts. */
  readonly attempts?: number;
  /** Attempts after the first request. */
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** Options for {@link httpRangeSource}. */
export interface HttpRangeSourceOptions {
  /** Static headers or a function evaluated for every probe/read attempt. */
  readonly headers?: HttpHeaders;
  /** Alias for callers that prefer an explicit dynamic-header name. */
  readonly getHeaders?: (context: HttpHeaderContext) =>
    HeadersInit | Promise<HeadersInit>;
  readonly credentials?: RequestCredentials;
  /** Injected fetch implementation, useful for SSR/tests. */
  readonly fetch?: HttpFetch;
  /** Defaults to strong ETag, with Last-Modified + length as a weak fallback. */
  readonly validation?: HttpValidationStrength;
  /** Compatibility alias for validation. */
  readonly validator?: HttpValidationStrength;
  /** Maximum simultaneous range reads (1–4, defaults to 1). */
  readonly maxConcurrency?: number;
  /** Number of retries after the first attempt (defaults to 2; 3 total attempts). */
  readonly retries?: number;
  readonly maxRetries?: number;
  readonly retry?: HttpRetryOptions;
  /** Explicit total-attempts spelling; takes precedence over retries. */
  readonly maxAttempts?: number;
  /** Explicitly permits a small full response when range requests are unavailable. */
  readonly fallback?: BoundedDownloadFallback;
  /** Optional logical display name. It is never sent in diagnostics. */
  readonly name?: string;
  /** Alias for name. */
  readonly sourceName?: string;
}

/** Fetch-compatible function accepted by the HTTP adapter. */
export type HttpFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 8;
const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_VALIDATOR_LENGTH = 4_096;
const RANGE_SOURCE_HOST_RESERVATION_STORE = Symbol.for(
  "tabulark.internal.range-source-reservation-store.v1",
);

interface RangeSourceHostReservations {
  reserveStaging(bytes: number, signal: AbortSignal): Promise<() => void>;
  reserveRetained(bytes: number): () => void;
}

function rangeSourceHostReservations(
  options: RangeSourceOpenOptions,
): RangeSourceHostReservations | undefined {
  try {
    const host = globalThis as typeof globalThis & {
      [RANGE_SOURCE_HOST_RESERVATION_STORE]?: WeakMap<object, unknown>;
    };
    const value = host[RANGE_SOURCE_HOST_RESERVATION_STORE]?.get(options);
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<RangeSourceHostReservations>;
    return typeof candidate.reserveStaging === "function"
      && typeof candidate.reserveRetained === "function"
      ? candidate as RangeSourceHostReservations
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a stable remote byte-range source.
 *
 * No request is made until `open()` is called.  Each open performs an
 * independent capability probe and returns an independent reader, allowing a
 * source to be reopened after a dataset is closed.
 */
export function httpRangeSource(
  url: string | URL,
  options: HttpRangeSourceOptions = {},
): RangeSource {
  if (
    (typeof url !== "string" && !(typeof URL !== "undefined" && url instanceof URL))
    || String(url).length === 0
  ) {
    throw invalidArgument("HTTP source URL must be a non-empty string");
  }
  const requestUrl = String(url);
  const normalized = normalizeOptions(options);
  const source: RangeSource = {
    kind: "range",
    ...(normalized.name === undefined ? {} : { name: normalized.name }),
    open: (openOptions) => openHttpReader(requestUrl, normalized, openOptions),
  };
  return Object.freeze(source);
}

interface NormalizedHttpOptions {
  readonly headers?: HttpHeaders;
  readonly getHeaders?: HttpRangeSourceOptions["getHeaders"];
  readonly credentials?: RequestCredentials;
  readonly fetch: HttpFetch;
  readonly validation: HttpValidationStrength;
  readonly maxConcurrency: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly fallback?: BoundedDownloadFallback;
  readonly name?: string;
}

async function openHttpReader(
  url: string,
  options: NormalizedHttpOptions,
  openOptions: RangeSourceOpenOptions,
): Promise<RangeSourceReader> {
  validateOpenOptions(openOptions);
  const openSignal = openOptions.signal;
  const maxSourceBytes = openOptions.maxSourceBytes;
  const maxStagingBytes = openOptions.maxStagingBytes;
  const hostReservations = rangeSourceHostReservations(openOptions);
  if (openSignal.aborted) throw cancelledError();

  const probeController = linkAbortSignal(openSignal);
  try {
    return await requestWithRetry(
      url,
      options,
      { phase: "probe", signal: probeController.controller.signal },
      async (response) => {
        if (response.status === 206) {
          const parsed = parseContentRange(response, 0, 1);
          if (parsed === undefined) {
            throw sourceError("RANGE_UNSUPPORTED", "The source returned an invalid byte range");
          }
          const size = parsed.total;
          assertSourceSize(size, maxSourceBytes);
          const validator = selectValidator(response, size, options.validation);
          await readOpenResponseBody(
            response,
            1,
            probeController.controller.signal,
            hostReservations,
          );
          const snapshot = createSnapshot(validator, size);
          return new HttpReader(
            url,
            options,
            size,
            snapshot,
            validator,
            maxStagingBytes,
            undefined,
            undefined,
          );
        }

        // An empty object cannot satisfy bytes=0-0. RFC 9110 represents that
        // one special case as 416 with `Content-Range: bytes */0`.
        if (response.status === 416 && parseUnsatisfiedContentRange(response) === 0) {
          assertSourceSize(0, maxSourceBytes);
          const validator = selectValidator(response, 0, options.validation);
          try { await response.body?.cancel(); } catch { /* best effort */ }
          const snapshot = createSnapshot(validator, 0);
          return new HttpReader(
            url,
            options,
            0,
            snapshot,
            validator,
            maxStagingBytes,
            undefined,
            undefined,
          );
        }

        if (response.status === 200 && options.fallback?.mode === "bounded-download") {
          const contentLength = parseContentLength(response);
          if (contentLength === undefined) {
            throw sourceError("RANGE_UNSUPPORTED", "The source does not provide a bounded length");
          }
          assertSourceSize(contentLength, maxSourceBytes);
          const bound = Math.min(options.fallback.maxBytes, maxStagingBytes);
          if (contentLength > bound) {
            throw resourceLimitError(contentLength, bound, "source-staging");
          }
          const validator = selectValidator(response, contentLength, options.validation);
          let releaseStaging: (() => void) | undefined;
          let releaseRetained: (() => void) | undefined;
          let bytes: ArrayBuffer;
          try {
            releaseStaging = await hostReservations?.reserveStaging(
              contentLength,
              probeController.controller.signal,
            );
            releaseRetained = hostReservations?.reserveRetained(contentLength);
            bytes = await readResponseBody(
              response,
              contentLength,
              probeController.controller.signal,
            );
          } catch (error) {
            releaseRetained?.();
            throw error;
          } finally {
            releaseStaging?.();
          }
          const snapshot = createSnapshot(validator, contentLength);
          return new HttpReader(
            url,
            options,
            contentLength,
            snapshot,
            validator,
            maxStagingBytes,
            bytes,
            releaseRetained,
          );
        }

        if (response.status === 416 || response.status === 200) {
          throw sourceError("RANGE_UNSUPPORTED", "The source does not support byte ranges");
        }
        throw responseError(response.status);
      },
    );
  } catch (error) {
    throw normalizeHttpError(error, "Unable to open the source");
  } finally {
    probeController.dispose();
  }
}

class HttpReader implements RangeSourceReader {
  readonly size: number;
  readonly snapshot: RangeSourceSnapshot;
  readonly maxConcurrency: number;
  #closed = false;
  #fallbackBytes: ArrayBuffer | undefined;
  #releaseRetained: (() => void) | undefined;
  readonly #url: string;
  readonly #options: NormalizedHttpOptions;
  readonly #validator: Validator;
  readonly #maxReadBytes: number;
  readonly #closeController = new AbortController();
  readonly #limiter: ReadLimiter;

  constructor(
    url: string,
    options: NormalizedHttpOptions,
    size: number,
    snapshot: RangeSourceSnapshot,
    validator: Validator,
    maxReadBytes: number,
    fallbackBytes: ArrayBuffer | undefined,
    releaseRetained: (() => void) | undefined,
  ) {
    this.#url = url;
    this.#options = options;
    this.size = size;
    this.snapshot = Object.freeze({ ...snapshot });
    this.#validator = validator;
    this.#maxReadBytes = maxReadBytes;
    this.#fallbackBytes = fallbackBytes;
    this.#releaseRetained = releaseRetained;
    this.maxConcurrency = options.maxConcurrency;
    this.#limiter = new ReadLimiter(this.maxConcurrency);
  }

  async read(
    range: ByteRange,
    options: { signal: AbortSignal },
  ): Promise<ArrayBuffer> {
    if (this.#closed) throw closedError("Range source reader");
    if (typeof options !== "object" || options === null || !isAbortSignal(options.signal)) {
      throw invalidArgument("range read options must include an AbortSignal");
    }
    let requestedRange: ByteRange;
    try {
      if (typeof range !== "object" || range === null) throw new RangeError();
      requestedRange = Object.freeze({
        offset: range.offset,
        length: range.length,
      });
      validateByteRange(requestedRange, this.size);
    } catch {
      // A malformed or out-of-bounds provider range is a structured source
      // failure at the public boundary; do not leak a native RangeError whose
      // shape differs between browsers.
      throw sourceError("RANGE_UNSUPPORTED", "The requested source range is outside the source");
    }
    // The request can wait behind the reader limiter and user-supplied header
    // callbacks. Snapshot the structural input now so caller/callback mutation
    // cannot bypass the staging check or alter the authoritative Range header.
    if (options.signal.aborted) throw cancelledError();
    if (requestedRange.length === 0) return new ArrayBuffer(0);
    if (requestedRange.length > this.#maxReadBytes) {
      throw resourceLimitError(requestedRange.length, this.#maxReadBytes, "source-staging");
    }
    const signal = combineSignals(this.#closeController.signal, options.signal);
    const release = await this.#limiter.acquire(signal);
    try {
      if (this.#closed) throw closedError("Range source reader");
      if (signal.aborted) throw cancelledError();
      if (this.#fallbackBytes !== undefined) {
        const view = new Uint8Array(
          this.#fallbackBytes,
          requestedRange.offset,
          requestedRange.length,
        );
        return copyRangeBytes(view);
      }
      return await requestWithRetry(
        this.#url,
        this.#options,
        { phase: "read", range: requestedRange, signal },
        async (response) => {
          if (response.status === 200 || response.status === 416) {
            throw sourceError("RANGE_UNSUPPORTED", "The source stopped supporting byte ranges");
          }
          if (response.status !== 206) throw responseError(response.status);
          const parsed = parseContentRange(
            response,
            requestedRange.offset,
            requestedRange.length,
          );
          if (parsed === undefined) {
            throw sourceError("RANGE_UNSUPPORTED", "The source returned an invalid byte range");
          }
          if (parsed.total !== this.size) {
            throw sourceError("SOURCE_CHANGED", "The source changed while it was open");
          }
          validateValidator(response, this.#validator, this.size);
          return readResponseBody(response, requestedRange.length, signal);
        },
      );
    } catch (error) {
      if (this.#closed) throw closedError("Range source reader");
      throw normalizeHttpError(error, "Unable to read the source");
    } finally {
      release();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#limiter.close();
    this.#closeController.abort();
    this.#fallbackBytes = undefined;
    this.#releaseRetained?.();
    this.#releaseRetained = undefined;
  }
}

interface Validator {
  readonly kind: "etag" | "last-modified";
  readonly value: string;
  readonly strength: "strong" | "weak";
}

function normalizeOptions(options: HttpRangeSourceOptions): NormalizedHttpOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalidArgument("HTTP source options must be an object");
  }
  const maxConcurrency = options.maxConcurrency ?? 1;
  if (!isSafeNonNegativeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
    throw invalidArgument("HTTP source maxConcurrency must be an integer from 1 to 4");
  }
  const validation = options.validation ?? options.validator ?? "strong";
  if (validation !== "strong" && validation !== "weak"
    && validation !== "etag" && validation !== "last-modified") {
    throw invalidArgument("HTTP source validation strength is invalid");
  }
  if (options.credentials !== undefined
    && options.credentials !== "omit"
    && options.credentials !== "same-origin"
    && options.credentials !== "include") {
    throw invalidArgument("HTTP source credentials are invalid");
  }
  const sourceName = options.name ?? options.sourceName;
  if (sourceName !== undefined
    && (typeof sourceName !== "string" || sourceName.length > 256)) {
    throw invalidArgument("HTTP source name is invalid");
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw invalidArgument("HTTP source fetch must be a function");
  }
  if (options.getHeaders !== undefined && typeof options.getHeaders !== "function") {
    throw invalidArgument("HTTP source getHeaders must be a function");
  }
  if (options.retry !== undefined
    && (typeof options.retry !== "object" || options.retry === null || Array.isArray(options.retry))) {
    throw invalidArgument("HTTP source retry options are invalid");
  }
  let maxAttempts = options.maxAttempts;
  if (maxAttempts === undefined) {
    maxAttempts = options.retry?.maxAttempts ?? options.retry?.attempts;
  }
  if (maxAttempts === undefined) {
    const retries = options.retry?.maxRetries ?? options.maxRetries ?? options.retries;
    maxAttempts = retries === undefined ? DEFAULT_ATTEMPTS : retries + 1;
  }
  if (!isSafeNonNegativeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw invalidArgument("HTTP source retry attempts are outside the supported range");
  }
  if (options.fallback !== undefined) {
    if (typeof options.fallback !== "object" || options.fallback === null
      || options.fallback.mode !== "bounded-download"
      || !isSafeNonNegativeInteger(options.fallback.maxBytes)
      || options.fallback.maxBytes > MAX_RANGE_SOURCE_BYTES) {
      throw invalidArgument("HTTP source fallback is invalid");
    }
  }
  const fetchImpl = options.fetch !== undefined
    ? options.fetch.bind(globalThis)
    : (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  if (fetchImpl === undefined) {
    throw new TabularkError("UNSUPPORTED_RUNTIME", "HTTP sources require fetch support");
  }
  let staticHeaders: HttpHeaders | undefined;
  if (options.headers !== undefined) {
    if (typeof options.headers === "function") {
      staticHeaders = options.headers;
    } else {
      try {
        staticHeaders = new Headers(options.headers);
      } catch {
        throw invalidArgument("HTTP source headers are invalid");
      }
    }
  }
  return Object.freeze({
    ...(staticHeaders === undefined ? {} : { headers: staticHeaders }),
    ...(options.getHeaders === undefined ? {} : { getHeaders: options.getHeaders }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    fetch: fetchImpl,
    validation,
    maxConcurrency,
    maxAttempts,
    ...(options.fallback === undefined ? {} : { fallback: Object.freeze({ ...options.fallback }) }),
    retryBaseDelayMs: normalizeDelay(options.retry?.baseDelayMs, INITIAL_BACKOFF_MS),
    retryMaxDelayMs: normalizeDelay(options.retry?.maxDelayMs, MAX_BACKOFF_MS),
    ...(sourceName === undefined ? {} : { name: sourceName }),
  });
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw invalidArgument("HTTP source retry delay is invalid");
  }
  return Math.min(MAX_BACKOFF_MS, Math.floor(value));
}

function validateOpenOptions(options: RangeSourceOpenOptions): void {
  if (typeof options !== "object" || options === null || !isAbortSignal(options.signal)) {
    throw invalidArgument("Range source open options must include an AbortSignal");
  }
  if (!isSafeNonNegativeInteger(options.maxSourceBytes)
    || !isSafeNonNegativeInteger(options.maxStagingBytes)) {
    throw invalidArgument("Range source limits must be safe non-negative integers");
  }
  // A non-empty range probe itself needs one bounded byte.  The engine always
  // supplies a positive staging slice, but rejecting an impossible direct
  // caller here keeps the provider contract structured and deterministic.
  if (options.maxStagingBytes === 0) {
    throw resourceLimitError(1, 0, "source-staging");
  }
}

function assertSourceSize(size: number, maxSourceBytes: number): void {
  if (!isSafeNonNegativeInteger(size) || size > MAX_RANGE_SOURCE_BYTES) {
    throw resourceLimitError(size, MAX_RANGE_SOURCE_BYTES, "source-address-space");
  }
  if (size > maxSourceBytes) {
    throw resourceLimitError(size, maxSourceBytes, "source-staging");
  }
}

async function requestWithRetry<T>(
  url: string,
  options: NormalizedHttpOptions,
  context: HttpHeaderContext,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const stableContext: HttpHeaderContext = Object.freeze({
    phase: context.phase,
    signal: context.signal,
    ...(context.range === undefined
      ? {}
      : { range: Object.freeze({ offset: context.range.offset, length: context.range.length }) }),
  });
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    if (stableContext.signal.aborted) throw cancelledError();
    // Header providers are application code, not transport I/O.  Prepare the
    // headers outside the fetch try/catch so a deterministic provider failure
    // is not accidentally retried as if it were a transient network error.
    const headers = await resolveHeaders(options, stableContext);
    let response: Response;
    try {
      if (stableContext.signal.aborted) throw cancelledError();
      const requestHeaders = new Headers(headers);
      if (stableContext.range === undefined) {
        requestHeaders.set("Range", "bytes=0-0");
      } else {
        const end = stableContext.range.offset + stableContext.range.length - 1;
        requestHeaders.set("Range", `bytes=${stableContext.range.offset}-${end}`);
      }
      response = await options.fetch(url, {
        method: "GET",
        headers: requestHeaders,
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        signal: stableContext.signal,
      });
    } catch (error) {
      if (stableContext.signal.aborted || isAbortLike(error)) throw cancelledError();
      if (attempt + 1 >= options.maxAttempts) {
        throw sourceError("SOURCE_UNAVAILABLE", "The source could not be reached", true);
      }
      await retryDelay(undefined, attempt, stableContext.signal, options);
      continue;
    }
    if (response.status === 0 && attempt + 1 < options.maxAttempts) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      await retryDelay(undefined, attempt, stableContext.signal, options);
      continue;
    }
    if (RETRYABLE_STATUSES.has(response.status) && attempt + 1 < options.maxAttempts) {
      // Release a response body before retrying. Some implementations keep a
      // connection occupied until body.cancel() is called.
      try { await response.body?.cancel(); } catch { /* best effort */ }
      await retryDelay(response, attempt, stableContext.signal, options);
      continue;
    }
    if (RETRYABLE_STATUSES.has(response.status)) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw sourceError("SOURCE_UNAVAILABLE", "The source returned a temporary failure", true, {
        status: response.status,
      });
    }
    if (response.status === 0) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw sourceError("SOURCE_UNAVAILABLE", "The source returned an unavailable response", true);
    }
    try {
      return await consume(response);
    } catch (error) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      if (!(error instanceof RetryableBodyError)) throw error;
      if (stableContext.signal.aborted) throw cancelledError();
      if (attempt + 1 >= options.maxAttempts) {
        throw sourceError("SOURCE_UNAVAILABLE", "The source body could not be read", true);
      }
      await retryDelay(undefined, attempt, stableContext.signal, options);
    }
  }
  throw sourceError("SOURCE_UNAVAILABLE", "The source could not be reached", true);
}

async function resolveHeaders(
  options: NormalizedHttpOptions,
  context: HttpHeaderContext,
): Promise<Headers> {
  try {
    let value: HeadersInit | undefined;
    if (typeof options.headers === "function") {
      value = await options.headers(context);
    } else {
      value = options.headers;
    }
    if (options.getHeaders !== undefined) {
      const dynamic = await options.getHeaders(context);
      value = mergeHeaders(value, dynamic);
    }
    return new Headers(value);
  } catch (error) {
    if (context.signal.aborted) throw cancelledError();
    throw sourceError("SOURCE_UNAVAILABLE", "The source request headers could not be prepared");
  }
}

function mergeHeaders(first: HeadersInit | undefined, second: HeadersInit): Headers {
  const merged = new Headers(first);
  new Headers(second).forEach((value, key) => merged.set(key, value));
  return merged;
}

function parseContentRange(
  response: Response,
  expectedOffset: number,
  expectedLength: number,
): { readonly total: number } | undefined {
  const value = responseHeader(response, "Content-Range");
  if (value === undefined) return undefined;
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/u.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!isSafeNonNegativeInteger(start)
    || !isSafeNonNegativeInteger(end)
    || !isSafeNonNegativeInteger(total)
    || start !== expectedOffset
    || end < start
    || end - start + 1 !== expectedLength
    || end >= total) {
    return undefined;
  }
  return { total };
}

function parseContentLength(response: Response): number | undefined {
  const value = responseHeader(response, "Content-Length");
  if (value === undefined || !/^[0-9]+$/u.test(value.trim())) return undefined;
  const length = Number(value.trim());
  return isSafeNonNegativeInteger(length)
    ? length
    : undefined;
}

function parseUnsatisfiedContentRange(response: Response): number | undefined {
  const value = responseHeader(response, "Content-Range");
  if (value === undefined) return undefined;
  const match = /^bytes \*\/([0-9]+)$/u.exec(value.trim());
  if (!match) return undefined;
  const total = Number(match[1]);
  return isSafeNonNegativeInteger(total) ? total : undefined;
}

function selectValidator(
  response: Response,
  size: number,
  strength: HttpValidationStrength,
): Validator {
  const etag = responseHeader(response, "ETag")?.trim();
  const validEtag = etag !== undefined
    && etag.length <= MAX_VALIDATOR_LENGTH
    && /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/u.test(etag)
    && (strength === "weak" || strength === "last-modified" || !etag.startsWith("W/"));
  if (strength === "etag" && !validEtag) {
    throw sourceError("SOURCE_UNAVAILABLE", "The source has no usable ETag validator");
  }
  if (validEtag) {
    if (strength === "last-modified") {
      // Continue to the explicit Last-Modified branch below.
    } else {
      return Object.freeze({
        kind: "etag",
        value: etag,
        strength: etag.startsWith("W/") ? "weak" : "strong",
      });
    }
  }
  const lastModified = responseHeader(response, "Last-Modified")?.trim();
  if (lastModified !== undefined
    && lastModified.length > 0
    && lastModified.length <= MAX_VALIDATOR_LENGTH
    && isHttpDate(lastModified)) {
    return Object.freeze({
      kind: "last-modified",
      value: `${lastModified}|${size}`,
      strength: "weak",
    });
  }
  throw sourceError("SOURCE_UNAVAILABLE", "The source has no usable validator");
}

function isHttpDate(value: string): boolean {
  // RFC 9110 HTTP-date: preferred IMF-fixdate plus the two obsolete forms
  // recipients are required to tolerate. Date.parse alone is far too broad
  // (for example, it accepts "0"), so syntax is constrained first.
  const day = "(?:0[1-9]|[12][0-9]|3[01])";
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const time = "(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]";
  const weekday = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
  const longWeekday = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
  const imf = new RegExp(`^${weekday}, ${day} ${month} [0-9]{4} ${time} GMT$`, "u");
  const rfc850 = new RegExp(`^${longWeekday}, ${day}-${month}-[0-9]{2} ${time} GMT$`, "u");
  const asctime = new RegExp(
    `^${weekday} ${month} (?: [1-9]|[12][0-9]|3[01]) ${time} [0-9]{4}$`,
    "u",
  );
  return (imf.test(value) || rfc850.test(value) || asctime.test(value))
    && Number.isFinite(Date.parse(value));
}

function validateValidator(response: Response, validator: Validator, size: number): void {
  if (validator.kind === "etag") {
    const current = responseHeader(response, "ETag")?.trim();
    if (current === undefined || current !== validator.value) {
      throw sourceError("SOURCE_CHANGED", "The source changed while it was open");
    }
    return;
  }
  const current = responseHeader(response, "Last-Modified")?.trim();
  if (current === undefined || `${current}|${size}` !== validator.value) {
    throw sourceError("SOURCE_CHANGED", "The source changed while it was open");
  }
}

function createSnapshot(validator: Validator, size: number): RangeSourceSnapshot {
  // Do not expose an ETag/URL in the public snapshot. This compact hash is
  // stable for the reader and opaque to diagnostics/performance telemetry.
  const id = `http-${hashOpaque(`${validator.kind}\u0000${validator.value}\u0000${size}`)}`;
  return Object.freeze({ id, strength: validator.strength });
}

function hashOpaque(value: string): string {
  // FNV-1a over UTF-16 code units; no crypto dependency is needed in workers
  // or test runtimes, and the value is only an identity hint rather than a
  // security primitive.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Accounts probe bytes that are read before a reader has joined the broker. */
async function readOpenResponseBody(
  response: Response,
  expectedLength: number,
  signal: AbortSignal,
  reservations: RangeSourceHostReservations | undefined,
): Promise<ArrayBuffer> {
  const release = await reservations?.reserveStaging(expectedLength, signal);
  try {
    return await readResponseBody(response, expectedLength, signal);
  } finally {
    release?.();
  }
}

/** Marks only transport failures that are safe to replay as a fresh GET. */
class RetryableBodyError extends Error {
  constructor(cause: unknown) {
    super("The source response body transport failed", { cause });
    this.name = "RetryableBodyError";
  }
}

async function readResponseBody(
  response: Response,
  expectedLength: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (signal.aborted) throw cancelledError();
  const rawContentLength = responseHeader(response, "Content-Length");
  if (rawContentLength !== undefined && parseContentLength(response) === undefined) {
    throw sourceError("SOURCE_UNAVAILABLE", "The source returned an invalid byte length");
  }
  const contentLength = parseContentLength(response);
  if (contentLength !== undefined && contentLength !== expectedLength) {
    throw sourceError("SOURCE_UNAVAILABLE", "The source returned an unexpected byte length", false, {
      expectedBytes: expectedLength,
      actualBytes: contentLength,
    });
  }
  const body = response.body;
  if (body !== null && body !== undefined && typeof body.getReader === "function") {
    const reader = body.getReader();
    const output = new Uint8Array(expectedLength);
    let offset = 0;
    const onAbort = (): void => {
      // Fetch implementations normally propagate the signal to the stream,
      // but a custom fetch/body double may not. Explicit cancellation keeps a
      // pending read from retaining a response after the caller closes or
      // aborts the reader.
      void Promise.resolve(reader.cancel()).catch(() => { /* best effort */ });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (offset < expectedLength) {
        if (signal.aborted) throw cancelledError();
        const result = await readResponseChunk(reader, signal);
        if (result.done) break;
        const chunk = toUint8Array(result.value);
        if (offset + chunk.byteLength > expectedLength) {
          throw sourceError("SOURCE_UNAVAILABLE", "The source returned too many bytes", false, {
            expectedBytes: expectedLength,
            actualBytes: offset + chunk.byteLength,
          });
        }
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== expectedLength) {
        throw sourceError("SOURCE_UNAVAILABLE", "The source returned too few bytes", false, {
          expectedBytes: expectedLength,
          actualBytes: offset,
        });
      }
      // Detect a long body even when the first expectedLength bytes arrived in
      // one chunk. A single extra read is bounded and never retained.
      const extra = await readResponseChunk(reader, signal);
      if (!extra.done) {
        const extraLength = toUint8Array(extra.value).byteLength;
        try { await reader.cancel(); } catch { /* best effort */ }
        throw sourceError("SOURCE_UNAVAILABLE", "The source returned too many bytes", false, {
          expectedBytes: expectedLength,
          actualBytes: expectedLength + extraLength,
        });
      }
      return output.buffer;
    } catch (error) {
      try { await reader.cancel(); } catch { /* best effort */ }
      if (signal.aborted || isAbortLike(error)) throw cancelledError();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
  }

  if (typeof response.arrayBuffer !== "function") {
    throw sourceError("SOURCE_UNAVAILABLE", "The source returned no readable body");
  }
  let rawValue: ArrayBuffer;
  try {
    rawValue = await response.arrayBuffer();
  } catch (error) {
    if (signal.aborted || isAbortLike(error)) throw cancelledError();
    throw new RetryableBodyError(error);
  }
  if (signal.aborted) throw cancelledError();
  let value: ArrayBuffer;
  try {
    value = copyRangeBytes(rawValue);
  } catch {
    throw sourceError("SOURCE_UNAVAILABLE", "The source returned an invalid body");
  }
  if (value.byteLength !== expectedLength) {
    throw sourceError("SOURCE_UNAVAILABLE", "The source returned an unexpected byte length", false, {
      expectedBytes: expectedLength,
      actualBytes: value.byteLength,
    });
  }
  return value;
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    if (signal.aborted || isAbortLike(error)) throw cancelledError();
    throw new RetryableBodyError(error);
  }
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw sourceError("SOURCE_UNAVAILABLE", "The source returned an invalid body");
}

function responseHeader(response: Response, name: string): string | undefined {
  const headers = response.headers;
  if (headers !== undefined && headers !== null && typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  // A tiny compatibility path for fetch test doubles that expose a plain
  // object instead of a Headers instance.
  const raw = headers as unknown as Record<string, unknown> | undefined;
  if (raw === undefined || raw === null) return undefined;
  for (const key of Object.keys(raw)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof raw[key] === "string") {
      return raw[key] as string;
    }
  }
  return undefined;
}

function responseError(status: number): TabularkError {
  return sourceError("SOURCE_UNAVAILABLE", "The source returned an unavailable response", false, {
    ...(Number.isSafeInteger(status) && status >= 0 ? { status } : {}),
  });
}

function sourceError(
  code: "SOURCE_UNAVAILABLE" | "SOURCE_CHANGED" | "RANGE_UNSUPPORTED",
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
): TabularkError {
  return new TabularkError(code, message, {
    retryable,
    ...(details === undefined ? {} : { details }),
  });
}

function resourceLimitError(requiredBytes: number, availableBytes: number, resource: string): TabularkError {
  return new TabularkError("RESOURCE_LIMIT", "The source exceeds its configured limit", {
    details: { resource, requiredBytes, availableBytes },
  });
}

function normalizeHttpError(error: unknown, fallbackMessage: string): TabularkError {
  const structured = tabularkErrorLike(error);
  if (structured !== undefined) {
    if (
      structured.code === "SOURCE_UNAVAILABLE"
      || structured.code === "SOURCE_CHANGED"
      || structured.code === "RANGE_UNSUPPORTED"
      || structured.code === "RESOURCE_LIMIT"
      || structured.code === "CANCELLED"
      || structured.code === "HANDLE_CLOSED"
    ) {
      // Rebuild the public error from a constrained vocabulary. A custom
      // fetch/provider (or a separately bundled stable entrypoint) is not
      // allowed to smuggle a URL, header, validator, message, or cause through
      // a thrown TabularkError-like value.
      if (structured.code === "RESOURCE_LIMIT") {
        return new TabularkError("RESOURCE_LIMIT", "The source exceeds its configured limit", {
          details: isSafeLimitDetails(structured.details),
        });
      }
      if (structured.code === "CANCELLED") return cancelledError();
      if (structured.code === "HANDLE_CLOSED") return closedError("Range source reader");
      return sourceError(
        structured.code as "SOURCE_UNAVAILABLE" | "SOURCE_CHANGED" | "RANGE_UNSUPPORTED",
        sourceErrorMessage(structured.code),
        structured.retryable,
        safeSourceDetails(structured.details),
      );
    }
    return sourceError("SOURCE_UNAVAILABLE", fallbackMessage, true);
  }
  // AbortError names vary across browsers and fetch implementations. Never
  // retain the implementation's message because it can contain a URL.
  if (isAbortLike(error)) return cancelledError();
  return sourceError("SOURCE_UNAVAILABLE", fallbackMessage, true);
}

/**
 * Stable entrypoints are independently bundled, so their TabularkError
 * constructors do not share identity. Recognize only the minimal public shape
 * and let normalizeHttpError rebuild every returned field from safe values.
 */
function tabularkErrorLike(value: unknown): {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
} | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const candidate = value as {
      readonly code?: unknown;
      readonly retryable?: unknown;
      readonly details?: unknown;
    };
    if (typeof candidate.code !== "string" || typeof candidate.retryable !== "boolean") {
      return undefined;
    }
    return {
      code: candidate.code,
      retryable: candidate.retryable,
      details: candidate.details,
    };
  } catch {
    return undefined;
  }
}

function isSafeLimitDetails(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { resource: "source-staging", requiredBytes: 0, availableBytes: 0 };
  }
  const raw = value as Record<string, unknown>;
  const resource = typeof raw.resource === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(raw.resource)
    ? raw.resource
    : "source-staging";
  const requiredBytes = isSafeNonNegativeInteger(raw.requiredBytes) ? raw.requiredBytes : 0;
  const availableBytes = isSafeNonNegativeInteger(raw.availableBytes) ? raw.availableBytes : 0;
  return { resource, requiredBytes, availableBytes };
}

function safeSourceDetails(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const details: Record<string, number> = {};
  for (const key of ["status", "expectedBytes", "actualBytes"] as const) {
    if (isSafeNonNegativeInteger(raw[key])) details[key] = raw[key];
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

function sourceErrorMessage(code: unknown): string {
  switch (code) {
    case "SOURCE_CHANGED": return "The source changed while it was open";
    case "RANGE_UNSUPPORTED": return "The source does not support the requested range";
    default: return "The source is unavailable";
  }
}

function isAbortLike(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && ((error as { name?: unknown }).name === "AbortError"
      || (error as { code?: unknown }).code === 20);
}

async function retryDelay(
  response: Response | undefined,
  attempt: number,
  signal: AbortSignal,
  options: Pick<NormalizedHttpOptions, "retryBaseDelayMs" | "retryMaxDelayMs">,
): Promise<void> {
  const retryAfter = response === undefined ? undefined : parseRetryAfter(response);
  const base = retryAfter ?? Math.min(
    options.retryMaxDelayMs,
    options.retryBaseDelayMs * 2 ** attempt,
  );
  const jittered = retryAfter === undefined
    ? Math.max(0, Math.min(options.retryMaxDelayMs, Math.round(base * (0.5 + Math.random()))))
    : Math.min(MAX_RETRY_AFTER_MS, base);
  if (jittered <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    const timer = setTimeout(done, jittered);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(cancelledError());
    };
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(response: Response): number | undefined {
  const value = responseHeader(response, "Retry-After")?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (/^[0-9]+$/u.test(value)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number(value) * 1_000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now()));
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object"
    && value !== null
    && typeof (value as { aborted?: unknown }).aborted === "boolean"
    && typeof (value as { addEventListener?: unknown }).addEventListener === "function";
}

interface LinkedController {
  readonly controller: AbortController;
  readonly dispose: () => void;
}

function linkAbortSignal(signal: AbortSignal): LinkedController {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal.aborted) controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (first === second) return first;
  const any = (AbortSignal as typeof AbortSignal & {
    any?: (signals: readonly AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof any === "function") return any([first, second]);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

class ReadLimiter {
  #active = 0;
  #closed = false;
  readonly #limit: number;
  readonly #queue: Array<QueuedPermit> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.#closed) return Promise.reject(closedError("Range source reader"));
    if (signal.aborted) return Promise.reject(cancelledError());
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry: QueuedPermit = { resolve, reject, signal, onAbort: () => undefined };
      const onAbort = (): void => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) this.#queue.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(cancelledError());
      };
      entry.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.reject(closedError("Range source reader"));
    }
  }

  private release(): void {
    this.#active = Math.max(0, this.#active - 1);
    if (this.#closed) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    next.signal.removeEventListener("abort", next.onAbort);
    if (next.signal.aborted) {
      next.reject(cancelledError());
      this.release();
      return;
    }
    this.#active += 1;
    next.resolve(() => this.release());
  }
}

interface QueuedPermit {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  onAbort: () => void;
}
