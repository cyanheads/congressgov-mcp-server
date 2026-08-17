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
 * - **The fetch** is bounded by {@link MAX_DOCUMENT_BYTES}, a request timeout, and
 *   a content-type allowlist. The body is extracted as it streams and only the
 *   requested window is kept, so what a read *retains* is flat in the size of
 *   the document and the ceiling bounds how long a response may run rather than
 *   how much of one fits in a buffer.
 * - **The response** is bounded by an exact character offset/limit window. Offsets
 *   index into the extracted plain text and are never snapped to section or
 *   paragraph breaks, so feeding `nextOffset` back walks a document with every
 *   character returned exactly once — no overlap, no gap.
 *
 * @module services/congress-documents/congress-documents-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { createStreamingExtractor, type ExtractedWindow } from './extract-text-stream.js';
import type { DocumentContent, FetchDocumentParams } from './types.js';

/**
 * Ceiling on a single document. The largest bodies Congress.gov publishes are
 * the omnibus appropriations acts — 116th Congress H.R. 133 enrolled runs
 * 6,790,482 bytes as Formatted Text and 9,812,888 as XML — and both formats of a
 * document have to clear it, since a caller sent to the other one by a recovery
 * hint would hit the same refusal. This clears the largest by better than a
 * factor of two; the request deadline is what a runaway response meets first.
 */
export const MAX_DOCUMENT_BYTES = 25_000_000;

/** Bounds the whole exchange, headers and body — a megabyte-scale body needs the room. */
export const REQUEST_TIMEOUT_MS = 30_000;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/** Every format URL these tools resolve points here; nothing else is fetched. */
const ALLOWED_HOSTS = new Set(['www.congress.gov']);

/** Content types the text extractor can read. PDF and everything else are refused. */
const ALLOWED_CONTENT_TYPES = new Set(['application/xml', 'text/html', 'text/plain', 'text/xml']);

/**
 * Contract reasons this service raises. The matching `recovery` hints live once
 * in `documentErrorContracts` (tool-helpers) and reach the wire via
 * `ctx.recoveryFor` — services have no `ctx.fail`, but carrying `reason` in
 * `data` plus the resolved hint gives clients the same shape.
 */
const DOCUMENT_UNAVAILABLE = 'document_unavailable';
const DOCUMENT_FETCH_FAILED = 'document_fetch_failed';
const DOCUMENT_TOO_LARGE = 'document_too_large';
const OFFSET_PAST_END = 'offset_past_end';

interface RequestContextLike extends Record<string, unknown> {
  operation: string;
  requestId: string;
  timestamp: string;
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
  constructor(private readonly maxDocumentBytes: number = MAX_DOCUMENT_BYTES) {}

  /**
   * Fetch one document and return the requested character window of its text.
   *
   * `url` comes from Congress.gov's own format metadata — a caller never supplies
   * one — and is still checked against {@link ALLOWED_HOSTS} before any request
   * goes out, so a redirected or malformed upstream link cannot turn this into a
   * general-purpose fetcher.
   */
  async fetchDocument(params: FetchDocumentParams, ctx: Context): Promise<DocumentContent> {
    this.assertAllowedHost(params.url, ctx);

    const operation = 'CongressDocumentsService GET document';
    const requestContext = this.getRequestContext(ctx, operation);
    const signal = this.getAbortSignal(ctx);

    const window = await withRetry(() => this.doFetch(params, requestContext, ctx, signal), {
      operation,
      context: requestContext,
      baseDelayMs: BASE_BACKOFF_MS,
      maxRetries: MAX_ATTEMPTS - 1,
      isTransient: (error: unknown) => this.isRetryableError(error),
      ...(signal ? { signal } : {}),
    });

    return this.describeWindow(window, params, ctx);
  }

  /** Describe the extracted `[offset, offset + limit)` window and what remains. */
  private describeWindow(
    window: ExtractedWindow,
    params: FetchDocumentParams,
    ctx: Context,
  ): DocumentContent {
    const { text, totalCharacters } = window;
    const offset = params.characterOffset;

    /** An empty document is a real (if unusual) answer at offset 0 — not a bad offset. */
    if (totalCharacters > 0 && offset >= totalCharacters) {
      throw invalidParams(
        `characterOffset ${offset} is past the end of this document, which has ${totalCharacters} characters.`,
        {
          reason: OFFSET_PAST_END,
          ...ctx.recoveryFor(OFFSET_PAST_END),
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

  private assertAllowedHost(url: string, ctx: Context): void {
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
          ...ctx.recoveryFor(DOCUMENT_UNAVAILABLE),
          retryable: false,
        },
      );
    }
  }

  private async doFetch(
    params: FetchDocumentParams,
    requestContext: RequestContextLike,
    ctx: Context,
    signal?: AbortSignal,
  ): Promise<ExtractedWindow> {
    let response: Response;
    try {
      response = await fetchWithTimeout(params.url, REQUEST_TIMEOUT_MS, requestContext, {
        headers: { Accept: 'text/html, application/xml, text/plain, */*' },
        expectedStatuses: [404],
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw this.classifyFetchError(error, ctx);
    }

    this.assertContentType(response, ctx);
    this.assertAdvertisedSize(response, ctx);
    return this.readWindow(response, params, ctx);
  }

  /**
   * A 404 means Congress.gov's metadata named a document its own file host does
   * not hold — a missing document, not a transport failure. Everything else
   * (5xx, timeout, socket error) is the transport, and stays retryable.
   */
  private classifyFetchError(error: unknown, ctx: Context): unknown {
    if (!(error instanceof McpError)) return error;
    if (error.code === JsonRpcErrorCode.NotFound) {
      return notFound(
        'Congress.gov does not hold the document its metadata pointed to.',
        {
          reason: DOCUMENT_UNAVAILABLE,
          ...ctx.recoveryFor(DOCUMENT_UNAVAILABLE),
          retryable: false,
        },
        { cause: error },
      );
    }
    /** The framework message embeds the request URL; re-message without echoing it. */
    return serviceUnavailable(
      'Unable to retrieve the document from Congress.gov.',
      { reason: DOCUMENT_FETCH_FAILED, ...ctx.recoveryFor(DOCUMENT_FETCH_FAILED) },
      { cause: error },
    );
  }

  private assertContentType(response: Response, ctx: Context): void {
    const raw = response.headers.get('content-type') ?? '';
    const mediaType = raw.split(';')[0]?.trim().toLowerCase() ?? '';
    if (ALLOWED_CONTENT_TYPES.has(mediaType)) return;
    throw serviceUnavailable(
      `Congress.gov returned content type '${mediaType || 'unknown'}', which this server cannot read as text.`,
      {
        reason: DOCUMENT_FETCH_FAILED,
        ...ctx.recoveryFor(DOCUMENT_FETCH_FAILED),
        contentType: mediaType,
        /** A wrong media type is deterministic — retrying re-downloads the same bytes. */
        retryable: false,
      },
    );
  }

  /** Refuse an oversized document on its advertised length, before reading a byte of it. */
  private assertAdvertisedSize(response: Response, ctx: Context): void {
    const header = response.headers.get('content-length');
    if (header === null) return;
    const contentLength = Number(header);
    if (!Number.isFinite(contentLength) || contentLength <= this.maxDocumentBytes) return;
    throw this.tooLarge(ctx, { contentLength });
  }

  /**
   * Extract the requested character window as the body streams, under a hard
   * byte budget that cancels the stream the moment it is exceeded.
   *
   * Nothing but the window is retained: the decoder carries a partial character
   * across a chunk boundary and the extractor carries its parse state, so the
   * live set stays near the window's own size however large the document is.
   * Transient allocation still scales with the body — peak RSS is higher than a
   * buffered read of the same document — but it is garbage, not live, so it is
   * concurrent reads rather than one large read that the ceiling has to survive.
   */
  private async readWindow(
    response: Response,
    params: FetchDocumentParams,
    ctx: Context,
  ): Promise<ExtractedWindow> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    const extractor = createStreamingExtractor({
      characterLimit: params.characterLimit,
      characterOffset: params.characterOffset,
    });
    let bytes = 0;

    if (reader) {
      for (;;) {
        const { done, value } = await this.readChunk(reader, ctx);
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > this.maxDocumentBytes) {
          await reader.cancel().catch(() => undefined);
          throw this.tooLarge(ctx, { bytesRead: bytes });
        }
        extractor.push(decoder.decode(value, { stream: true }));
      }
    }

    if (bytes === 0) {
      throw serviceUnavailable('Congress.gov returned an empty document body.', {
        reason: DOCUMENT_FETCH_FAILED,
        ...ctx.recoveryFor(DOCUMENT_FETCH_FAILED),
        retryable: false,
      });
    }

    extractor.push(decoder.decode());
    return extractor.finish();
  }

  /**
   * A body that dies partway through is the transport failing, not a malformed
   * document — the same classification a connection that never opened gets.
   */
  private async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    ctx: Context,
  ): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
    try {
      return await reader.read();
    } catch (error) {
      throw serviceUnavailable(
        'The document body from Congress.gov ended before it was complete.',
        { reason: DOCUMENT_FETCH_FAILED, ...ctx.recoveryFor(DOCUMENT_FETCH_FAILED) },
        { cause: error },
      );
    }
  }

  private tooLarge(ctx: Context, data: Record<string, unknown>): McpError {
    return invalidParams(
      `This document exceeds the ${this.maxDocumentBytes.toLocaleString('en-US')}-byte ceiling this server retrieves.`,
      {
        reason: DOCUMENT_TOO_LARGE,
        ...ctx.recoveryFor(DOCUMENT_TOO_LARGE),
        ...data,
        maxBytes: this.maxDocumentBytes,
        retryable: false,
      },
    );
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof McpError) {
      if (error.data?.retryable === false) return false;
      return (
        error.code === JsonRpcErrorCode.ServiceUnavailable ||
        error.code === JsonRpcErrorCode.Timeout
      );
    }
    return true;
  }

  private getRequestContext(ctx: Context, operation: string): RequestContextLike {
    const ctxRecord = ctx as unknown as Record<string, unknown>;
    const requestId =
      typeof ctxRecord.requestId === 'string' ? ctxRecord.requestId : 'congress-documents-service';
    const timestamp =
      typeof ctxRecord.timestamp === 'string' ? ctxRecord.timestamp : new Date().toISOString();
    return { operation, requestId, timestamp };
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
