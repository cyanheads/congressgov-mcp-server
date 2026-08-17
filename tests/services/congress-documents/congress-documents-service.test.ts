/**
 * @fileoverview Tests for CongressDocumentsService — host allowlisting, the byte
 * ceiling on the fetch itself, content-type validation, and the exact-offset
 * character window (including a full round-trip walk that must reassemble the
 * source byte-for-byte).
 * @module tests/services/congress-documents/congress-documents-service.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CongressDocumentsService,
  getCongressDocuments,
  initCongressDocuments,
} from '@/services/congress-documents/congress-documents-service.js';

const URL_BILL = 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.htm';

/** A test ceiling small enough to hit without allocating megabytes. */
const CEILING = 2048;

/** Roomy enough that only the ceiling tests are bounded by it. */
const ROOMY = 1_000_000;

/** A `Response` with a body the runtime can length-annotate (Content-Length path). */
function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html', ...headers },
  });
}

/** A `Response` streamed from a chunked source — no Content-Length advertised. */
function streamedResponse(body: string, contentType = 'text/html'): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 256) {
        controller.enqueue(bytes.slice(i, i + 256));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

function errorResponse(status: number): Response {
  return new Response('<html><body>error</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

/** Wrap `text` in the `<pre>` shell Congress.gov serves, so extraction yields `text`. */
function preDoc(text: string): string {
  return `<pre>\n${text}\n</pre>`;
}

/** A document long enough to need several windows. */
const LONG_TEXT = Array.from(
  { length: 40 },
  (_, i) =>
    `SEC. ${i + 1}. SECTION HEADING NUMBER ${i + 1}.\n\n    Body line for section ${i + 1}.`,
).join('\n\n');

describe('CongressDocumentsService', () => {
  const mockFetch = vi.fn();
  let service: CongressDocumentsService;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    service = new CongressDocumentsService(ROOMY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetching', () => {
    it('requests the resolved URL', async () => {
      mockFetch.mockResolvedValue(htmlResponse(preDoc('Hello.')));
      await service.fetchDocument(
        { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
        createMockContext(),
      );
      expect(String(mockFetch.mock.calls[0]![0])).toBe(URL_BILL);
    });

    it('rejects a URL outside www.congress.gov without fetching it', async () => {
      const error = (await service
        .fetchDocument(
          { url: 'https://evil.example.com/doc.htm', characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('document_unavailable');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('maps a 404 from congress.gov to document_unavailable and does not retry it', async () => {
      mockFetch.mockResolvedValue(errorResponse(404));
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('document_unavailable');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('maps a 503 to a retryable document_fetch_failed', async () => {
      mockFetch.mockResolvedValue(errorResponse(503));
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('document_fetch_failed');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('maps a network failure to document_fetch_failed', async () => {
      mockFetch.mockRejectedValue(new Error('socket hang up'));
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('document_fetch_failed');
    });

    it('rejects a content type it cannot read as text', async () => {
      mockFetch.mockResolvedValue(
        new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }),
      );
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.data?.reason).toBe('document_fetch_failed');
      expect(error.message).toMatch(/application\/pdf/);
    });

    it('accepts an XML content type', async () => {
      mockFetch.mockResolvedValue(
        new Response('<bill><text>Sec. 1.</text></bill>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
      );
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
        createMockContext(),
      );
      expect(result.text).toBe('Sec. 1.');
    });

    it('rejects an empty body as a fetch failure', async () => {
      mockFetch.mockResolvedValue(htmlResponse(''));
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.data?.reason).toBe('document_fetch_failed');
    });
  });

  describe('size ceiling', () => {
    beforeEach(() => {
      service = new CongressDocumentsService(CEILING);
    });

    it('accepts a document of exactly the ceiling', async () => {
      const body = 'x'.repeat(CEILING);
      mockFetch.mockResolvedValue(streamedResponse(body));
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 0, characterLimit: CEILING },
        createMockContext(),
      );
      expect(result.totalCharacters).toBe(CEILING);
    });

    it('rejects a document one byte over the ceiling while streaming', async () => {
      mockFetch.mockResolvedValue(streamedResponse('x'.repeat(CEILING + 1)));
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('document_too_large');
      expect(error.data?.maxBytes).toBe(CEILING);
    });

    it('rejects on the advertised Content-Length before reading the body', async () => {
      mockFetch.mockResolvedValue(
        htmlResponse('short', { 'content-length': String(CEILING * 10) }),
      );
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.data?.reason).toBe('document_too_large');
      expect(error.data?.contentLength).toBe(CEILING * 10);
    });

    it('does not retry an oversized document', async () => {
      mockFetch.mockResolvedValue(streamedResponse('x'.repeat(CEILING + 1)));
      await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        )
        .catch(() => undefined);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('character window', () => {
    beforeEach(() => {
      /** A fresh Response per call — a walk fetches repeatedly and a body streams once. */
      mockFetch.mockImplementation(() => Promise.resolve(streamedResponse(preDoc(LONG_TEXT))));
    });

    it('returns the whole document when the limit exceeds its length', async () => {
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 0, characterLimit: LONG_TEXT.length + 500 },
        createMockContext(),
      );
      expect(result.text).toBe(LONG_TEXT);
      expect(result.totalCharacters).toBe(LONG_TEXT.length);
      expect(result.offset).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it('cuts at the exact character boundary, without snapping to a section break', async () => {
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 0, characterLimit: 37 },
        createMockContext(),
      );
      expect(result.text).toBe(LONG_TEXT.slice(0, 37));
      expect(result.text).toHaveLength(37);
      expect(result.truncated).toBe(true);
      expect(result.nextOffset).toBe(37);
    });

    it('resumes at the exact offset it was given', async () => {
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 37, characterLimit: 40 },
        createMockContext(),
      );
      expect(result.text).toBe(LONG_TEXT.slice(37, 77));
      expect(result.offset).toBe(37);
      expect(result.nextOffset).toBe(77);
    });

    it('walks the whole document via nextOffset and reassembles it exactly', async () => {
      const chunks: string[] = [];
      const offsets: number[] = [];
      let offset: number | null = 0;
      let guard = 0;

      while (offset !== null) {
        if (++guard > 200) throw new Error('walk did not terminate');
        offsets.push(offset);
        const page: Awaited<ReturnType<CongressDocumentsService['fetchDocument']>> =
          await service.fetchDocument(
            { url: URL_BILL, characterOffset: offset, characterLimit: 100 },
            createMockContext(),
          );
        expect(page.offset).toBe(offset);
        expect(page.totalCharacters).toBe(LONG_TEXT.length);
        chunks.push(page.text);
        offset = page.nextOffset;
      }

      expect(chunks.join('')).toBe(LONG_TEXT);
      /** No overlap and no gap: each offset is the exact sum of what came before. */
      let running = 0;
      for (const [i, start] of offsets.entries()) {
        expect(start).toBe(running);
        running += chunks[i]!.length;
      }
      expect(running).toBe(LONG_TEXT.length);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('yields the final partial window with truncated false', async () => {
      const last = LONG_TEXT.length - 10;
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: last, characterLimit: 100 },
        createMockContext(),
      );
      expect(result.text).toBe(LONG_TEXT.slice(last));
      expect(result.text).toHaveLength(10);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it('rejects an offset exactly at totalCharacters', async () => {
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: LONG_TEXT.length, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('offset_past_end');
      expect(error.data?.totalCharacters).toBe(LONG_TEXT.length);
    });

    it('rejects an offset past the end', async () => {
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: LONG_TEXT.length + 5_000, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.data?.reason).toBe('offset_past_end');
      expect(error.message).toContain(String(LONG_TEXT.length));
    });
  });

  describe('empty document', () => {
    it('returns an empty window rather than an offset error', async () => {
      mockFetch.mockResolvedValue(streamedResponse('<pre>\n   \n</pre>'));
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
        createMockContext(),
      );
      expect(result.text).toBe('');
      expect(result.totalCharacters).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.nextOffset).toBeNull();
    });
  });

  describe('singleton', () => {
    it('initializes and returns the service', () => {
      expect(() => initCongressDocuments()).not.toThrow();
      expect(() => getCongressDocuments()).not.toThrow();
    });
  });
});
