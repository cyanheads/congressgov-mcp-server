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
  MAX_DOCUMENT_BYTES,
} from '@/services/congress-documents/congress-documents-service.js';
import { extractDocumentText } from '@/services/congress-documents/extract-text.js';

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
function streamedResponse(body: string, contentType = 'text/html', chunkSize = 256): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

/** A `Response` whose body dies after delivering part of the document. */
function truncatedStreamResponse(prefix: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      controller.error(new Error('connection reset by peer'));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
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

    it('maps a body that dies mid-stream to a retryable document_fetch_failed', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(truncatedStreamResponse(preDoc('SEC. 1. The beginning of'))),
      );
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

    it('accepts a document one byte under the ceiling', async () => {
      mockFetch.mockResolvedValue(streamedResponse('x'.repeat(CEILING - 1)));
      const result = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 0, characterLimit: CEILING },
        createMockContext(),
      );
      expect(result.totalCharacters).toBe(CEILING - 1);
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

  /**
   * The largest enacted bills clear five megabytes in both published formats —
   * 116th Congress H.R. 133 is 6,790,482 bytes as Formatted Text and 9,812,888
   * as XML — and neither could be read at all while the fetch had to fit in a
   * buffer. Nothing here is held in memory but the requested window.
   */
  describe('documents past five megabytes', () => {
    const sections = Array.from(
      { length: 30_000 },
      (_, i) =>
        `\nSEC. ${i + 1}. SHORT TITLE OF SECTION ${i + 1}.\n\n    In this section, an amount &lt;= $${i},000 &amp; not more.\n    Paragraph body for section ${i + 1}, padded to a realistic GPO line width.\n`,
    ).join('');
    const body = `<html><body><pre>\n[Congressional Bills 116th Congress]\n${sections}</pre></body></html>\n`;
    const reference = extractDocumentText(body);

    beforeEach(() => {
      /** The shipped ceiling, not the roomy test one — its size is the point. */
      service = new CongressDocumentsService();
      mockFetch.mockImplementation(() =>
        Promise.resolve(streamedResponse(body, 'text/html', 65_536)),
      );
    });

    it('is a document the former 5,000,000-byte ceiling refused', () => {
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(5_000_000);
      expect(new TextEncoder().encode(body).byteLength).toBeLessThan(MAX_DOCUMENT_BYTES);
    });

    it('declares a ceiling that clears both published formats of H.R. 133', () => {
      expect(MAX_DOCUMENT_BYTES).toBeGreaterThan(9_812_888);
    });

    it('serves a window from the start, the middle, and the end', async () => {
      const offsets = [0, Math.floor(reference.length / 2), reference.length - 100];
      for (const offset of offsets) {
        const result = await service.fetchDocument(
          { url: URL_BILL, characterOffset: offset, characterLimit: 100_000 },
          createMockContext(),
        );
        expect(result.totalCharacters, `offset ${offset}`).toBe(reference.length);
        expect(result.offset).toBe(offset);
        expect(result.text, `offset ${offset}`).toBe(reference.slice(offset, offset + 100_000));
      }
    });

    it('walks the whole document via nextOffset and reassembles it exactly', async () => {
      const chunks: string[] = [];
      let offset: number | null = 0;
      let running = 0;

      while (offset !== null) {
        const page: Awaited<ReturnType<CongressDocumentsService['fetchDocument']>> =
          await service.fetchDocument(
            { url: URL_BILL, characterOffset: offset, characterLimit: 250_000 },
            createMockContext(),
          );
        expect(page.offset).toBe(offset);
        expect(page.offset).toBe(running);
        expect(page.totalCharacters).toBe(reference.length);
        chunks.push(page.text);
        running += page.text.length;
        offset = page.nextOffset;
      }

      expect(chunks.join('')).toBe(reference);
      expect(running).toBe(reference.length);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('rejects an offset past the end rather than serving an empty window', async () => {
      const error = (await service
        .fetchDocument(
          { url: URL_BILL, characterOffset: reference.length, characterLimit: 100 },
          createMockContext(),
        )
        .catch((e: unknown) => e)) as McpError;
      expect(error.data?.reason).toBe('offset_past_end');
      expect(error.data?.totalCharacters).toBe(reference.length);
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
