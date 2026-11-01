/**
 * @fileoverview Bounded retrieval of legislative document text from www.congress.gov.
 *
 * The document bodies behind Congress.gov's format URLs live on `www.congress.gov`
 * — a different host from the `api.congress.gov` that `CongressApiService` is
 * scoped to, with no API key, no JSON, and documents that run past a megabyte.
 * That is a second upstream, not a second method on the API client, so it gets
 * its own service the way `SenateVoteService` does for the Senate LIS feed.
 *
 * Two bounds, deliberately separate:
 * - **The fetch** is bounded by {@link MAX_DOCUMENT_BYTES}, a per-attempt timeout,
 *   the tool call's one time budget (`call-budget.ts`), which the format lookup
 *   before it spends from too, and a content-type allowlist. The body is
 *   extracted as it streams and only the requested window is extracted into
 *   memory, so the ceiling bounds how long a response may run rather than how
 *   much of one fits in a buffer.
 * - **The response** is bounded by an exact character offset/limit window. Offsets
 *   index into the extracted plain text and are never snapped to section or
 *   paragraph breaks, so feeding `nextOffset` back walks a document with every
 *   character returned exactly once — no overlap, no gap.
 *
 * Every window streams the whole body to learn `totalCharacters`, so a walk
 * would fetch its document once per window. Instead the first read of a
 * document that runs past its window keeps the decompressed body in a
 * {@link DocumentBodyCache} (64 MB total, 16 MB per body, 10-minute TTL), and
 * later windows replay those bytes through the same extractor: one fetch per
 * document per TTL. A replay is local work and never touches the time budget.
 *
 * @module services/congress-documents/congress-documents-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  requestCancelled,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import {
  defaultIsTransient,
  fetchWithTimeout,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';
import { type BudgetedAttempt, withCallBudget } from '@/services/call-budget.js';
import { type BodyCapture, DocumentBodyCache } from './document-body-cache.js';
import { createStreamingExtractor, type ExtractedWindow } from './extract-text-stream.js';
import type { DocumentContent, FetchDocumentParams } from './types.js';

/**
 * Ceiling on a single document. The largest bodies Congress.gov publishes are
 * the omnibus appropriations acts — 116th Congress H.R. 133 enrolled runs
 * 6,790,482 bytes as Formatted Text and 9,812,888 as XML — and both formats of a
 * document have to clear it, since a caller sent to the other one by a recovery
 * hint would hit the same refusal. This clears the largest by better than a
 * factor of two; the per-attempt timeout is what a runaway response meets first.
 */
export const MAX_DOCUMENT_BYTES = 25_000_000;

/**
 * Bounds one attempt's whole exchange, headers and body — a megabyte-scale body
 * needs the room. Clamped to what is left of the call's budget.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Largest piece of a cached body replayed between macrotask yields. Replaying
 * from memory has no network waits, so without the yields a large document's
 * whole parse would hold the event loop in one block.
 */
const REPLAY_SLICE_BYTES = 128 * 1024;

/** Every format URL these tools resolve points here; nothing else is fetched. */
const ALLOWED_HOSTS = new Set(['www.congress.gov']);

/** Content types the text extractor can read. PDF and everything else are refused. */
const ALLOWED_CONTENT_TYPES = new Set(['application/xml', 'text/html', 'text/plain', 'text/xml']);

/**
 * Contract reasons this service raises. The matching `recovery` hints live once
 * in `documentErrorContracts` (tool-helpers). Carrying `reason` in `data` lets
 * the framework fill that hint on both client surfaces.
 */
const DOCUMENT_UNAVAILABLE = 'document_unavailable';
const DOCUMENT_FETCH_FAILED = 'document_fetch_failed';
const DOCUMENT_TOO_LARGE = 'document_too_large';
const OFFSET_PAST_END = 'offset_past_end';

/** One fetched read: its window, and the body captured for the cache along the way. */
interface FetchedWindow {
  body: BodyCapture;
  window: ExtractedWindow;
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  if (
    typeof AbortSignal !== 'function' ||
    typeof AbortSignal.prototype.throwIfAborted !== 'function' ||
    !value
  ) {
    return false;
  }
  try {
    AbortSignal.prototype.throwIfAborted.call(value);
    return true;
  } catch (error) {
    return !(error instanceof TypeError);
  }
}

export class CongressDocumentsService {
  constructor(
    private readonly maxDocumentBytes: number = MAX_DOCUMENT_BYTES,
    private readonly bodyCache: DocumentBodyCache = new DocumentBodyCache(),
  ) {}

  /**
   * Fetch one document and return the requested character window of its text.
   *
   * `url` comes from Congress.gov's own format metadata — a caller never supplies
   * one — and is still checked against {@link ALLOWED_HOSTS} before any request
   * goes out, so a redirected or malformed upstream link cannot turn this into a
   * general-purpose fetcher.
   *
   * A document whose body is cached is replayed from it with no request at all.
   * Otherwise the fetch spends what is left of the tool call's budget
   * (`call-budget.ts`): running out throws `Timeout` (`upstream_timeout`), and a
   * caller abort ends the call at once.
   */
  async fetchDocument(params: FetchDocumentParams, ctx: Context): Promise<DocumentContent> {
    this.assertAllowedHost(params.url);

    const signal = this.getAbortSignal(ctx);
    const cached = this.bodyCache.get(params.url);
    if (cached) return this.describeWindow(await this.replayWindow(cached, params, signal), params);

    const operation = 'CongressDocumentsService GET document';
    const requestContext = this.getRequestContext(ctx, operation);
    const read = await withCallBudget((attempt) => this.doFetch(params, requestContext, attempt), {
      call: ctx,
      attemptTimeoutMs: REQUEST_TIMEOUT_MS,
      upstream: 'Congress.gov',
      request: 'the document',
      operation,
      context: requestContext,
      baseDelayMs: BASE_BACKOFF_MS,
      maxRetries: MAX_ATTEMPTS - 1,
      isTransient: (error: unknown) => this.isRetryableError(error),
      ...(signal ? { signal } : {}),
    });

    const content = this.describeWindow(read.window, params);
    /** A document the window covers to its end is never retained. */
    if (content.nextOffset !== null) this.bodyCache.insert(params.url, read.body);
    return content;
  }

  /**
   * Serve a window from a cached body: the decoder and extractor a fetch feeds,
   * given the body in slices with a macrotask between them, checking the
   * caller's signal at each one.
   */
  private async replayWindow(
    body: Uint8Array,
    params: FetchDocumentParams,
    signal?: AbortSignal,
  ): Promise<ExtractedWindow> {
    const decoder = new TextDecoder('utf-8');
    const extractor = createStreamingExtractor({
      characterLimit: params.characterLimit,
      characterOffset: params.characterOffset,
    });
    for (let start = 0; start < body.byteLength; start += REPLAY_SLICE_BYTES) {
      if (start > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) throw requestCancelled('The document read was cancelled.');
      const slice = body.subarray(start, start + REPLAY_SLICE_BYTES);
      extractor.push(decoder.decode(slice, { stream: true }));
    }
    extractor.push(decoder.decode());
    return extractor.finish();
  }

  /** Describe the extracted `[offset, offset + limit)` window and what remains. */
  private describeWindow(window: ExtractedWindow, params: FetchDocumentParams): DocumentContent {
    const { text, totalCharacters } = window;
    const offset = params.characterOffset;

    /** An empty document is a real (if unusual) answer at offset 0 — not a bad offset. */
    if (totalCharacters > 0 && offset >= totalCharacters) {
      throw validationError(
        `characterOffset ${offset} is past the end of this document, which has ${totalCharacters} characters.`,
        {
          reason: OFFSET_PAST_END,
          totalCharacters,
          offset,
          retryable: false,
        },
      );
    }

    const end = offset + text.length;
    const truncated = end < totalCharacters;
    return {
      text,
      totalCharacters,
      offset,
      truncated,
      nextOffset: truncated ? end : null,
    };
  }

  private assertAllowedHost(url: string): void {
    let host: string | undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') host = parsed.hostname;
    } catch {
      host = undefined;
    }
    if (host === undefined || !ALLOWED_HOSTS.has(host.toLowerCase())) {
      throw notFound(
        'The upstream metadata points at a document this server does not retrieve — only documents hosted on www.congress.gov are read.',
        {
          reason: DOCUMENT_UNAVAILABLE,
          retryable: false,
        },
      );
    }
  }

  /**
   * One attempt. `attempt.signal` carries both the caller's abort and the call
   * budget, so either ends an exchange already in flight, body included.
   */
  private async doFetch(
    params: FetchDocumentParams,
    requestContext: RequestContext,
    attempt: BudgetedAttempt,
  ): Promise<FetchedWindow> {
    let response: Response;
    try {
      response = await fetchWithTimeout(params.url, attempt.timeoutMs, requestContext, {
        headers: { Accept: 'text/html, application/xml, text/plain, */*' },
        expectedStatuses: [404],
        signal: attempt.signal,
      });
    } catch (error) {
      throw this.classifyFetchError(error);
    }

    this.assertContentType(response);
    this.assertAdvertisedSize(response);
    return this.readWindow(response, params);
  }

  /**
   * A 404 means Congress.gov's metadata named a document its own file host does
   * not hold — a missing document, not a transport failure. Everything else
   * (5xx, timeout, socket error) is the transport, and stays retryable.
   */
  private classifyFetchError(error: unknown): unknown {
    if (!(error instanceof McpError)) return error;
    if (error.code === JsonRpcErrorCode.RequestCancelled) return error;
    if (error.code === JsonRpcErrorCode.NotFound) {
      return notFound(
        'Congress.gov does not hold the document its metadata pointed to.',
        {
          reason: DOCUMENT_UNAVAILABLE,
          retryable: false,
        },
        { cause: error },
      );
    }
    /** Keep the document-specific message; the framework redacts the cause's URL. */
    return serviceUnavailable(
      'Unable to retrieve the document from Congress.gov.',
      {
        reason: DOCUMENT_FETCH_FAILED,
        ...(error.data?.retryable === false ? { retryable: false } : {}),
      },
      { cause: error },
    );
  }

  private assertContentType(response: Response): void {
    const raw = response.headers.get('content-type') ?? '';
    const mediaType = raw.split(';')[0]?.trim().toLowerCase() ?? '';
    if (ALLOWED_CONTENT_TYPES.has(mediaType)) return;
    throw serviceUnavailable(
      `Congress.gov returned content type '${mediaType || 'unknown'}', which this server cannot read as text.`,
      {
        reason: DOCUMENT_FETCH_FAILED,
        contentType: mediaType,
        /** A wrong media type is deterministic — retrying re-downloads the same bytes. */
        retryable: false,
      },
    );
  }

  /** Refuse an oversized document on its advertised length, before reading a byte of it. */
  private assertAdvertisedSize(response: Response): void {
    const header = response.headers.get('content-length');
    if (header === null) return;
    const contentLength = Number(header);
    if (!Number.isFinite(contentLength) || contentLength <= this.maxDocumentBytes) return;
    throw this.tooLarge({ contentLength });
  }

  /**
   * Extract the requested character window as the body streams, under a hard
   * byte budget that cancels the stream the moment it is exceeded.
   *
   * Only the window is extracted into memory: the decoder carries a partial
   * character across a chunk boundary and the extractor carries its parse
   * state. The raw chunks are also captured for the body cache, up to its entry
   * ceiling and no further, so a body past that ceiling keeps the read's live
   * set near the window's own size. Transient allocation still scales with the
   * body — peak RSS is higher than a buffered read of the same document — but
   * it is garbage, not live, so it is concurrent reads rather than one large
   * read that the ceiling has to survive.
   */
  private async readWindow(
    response: Response,
    params: FetchDocumentParams,
  ): Promise<FetchedWindow> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    const extractor = createStreamingExtractor({
      characterLimit: params.characterLimit,
      characterOffset: params.characterOffset,
    });
    const body = this.bodyCache.capture();
    let bytes = 0;

    if (reader) {
      for (;;) {
        const { done, value } = await this.readChunk(reader);
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > this.maxDocumentBytes) {
          await reader.cancel().catch(() => undefined);
          throw this.tooLarge({ bytesRead: bytes });
        }
        body.add(value);
        extractor.push(decoder.decode(value, { stream: true }));
      }
    }

    if (bytes === 0) {
      throw serviceUnavailable('Congress.gov returned an empty document body.', {
        reason: DOCUMENT_FETCH_FAILED,
        retryable: false,
      });
    }

    extractor.push(decoder.decode());
    return { window: extractor.finish(), body };
  }

  /**
   * A body that dies partway through is the transport failing, not a malformed
   * document — the same classification a connection that never opened gets. A
   * caller abort mid-body stays the cancellation it is.
   */
  private async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
    try {
      return await reader.read();
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.RequestCancelled) {
        throw error;
      }
      throw serviceUnavailable(
        'The document body from Congress.gov ended before it was complete.',
        { reason: DOCUMENT_FETCH_FAILED },
        { cause: error },
      );
    }
  }

  private tooLarge(data: Record<string, unknown>): McpError {
    return validationError(
      `This document exceeds the ${this.maxDocumentBytes.toLocaleString('en-US')}-byte ceiling this server retrieves.`,
      {
        reason: DOCUMENT_TOO_LARGE,
        ...data,
        maxBytes: this.maxDocumentBytes,
        retryable: false,
      },
    );
  }

  private isRetryableError(error: unknown): boolean {
    return (
      !(error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited) &&
      defaultIsTransient(error)
    );
  }

  /**
   * Derive the context the network helpers log and report against. `Context`
   * extends `RequestContext`, so the handler's own context is the parent — the
   * request ID carries through and only the operation label is per-call.
   */
  private getRequestContext(ctx: Context, operation: string): RequestContext {
    return requestContextService.createRequestContext({ operation, parentContext: ctx });
  }

  private getAbortSignal(ctx: Context): AbortSignal | undefined {
    const signal = ctx.signal;
    return isNativeAbortSignal(signal) ? signal : undefined;
  }
}

let _service: CongressDocumentsService | undefined;

export function initCongressDocuments(): void {
  _service = new CongressDocumentsService();
}

export function getCongressDocuments(): CongressDocumentsService {
  if (!_service) {
    throw new Error(
      'CongressDocumentsService not initialized — call initCongressDocuments() in setup()',
    );
  }
  return _service;
}
