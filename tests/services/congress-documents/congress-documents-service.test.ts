/**
 * @fileoverview Tests for CongressDocumentsService — host allowlisting, the byte
 * ceiling on the fetch itself, content-type validation, the exact-offset
 * character window (including a full round-trip walk that must reassemble the
 * source byte-for-byte), and the one time budget a `content` call's upstream
 * requests share, through the service and through each tool that reaches it.
 * @module tests/services/congress-documents/congress-documents-service.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { congressErrorContracts } from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import {
  CongressDocumentsService,
  getCongressDocuments,
  initCongressDocuments,
  MAX_DOCUMENT_BYTES,
} from '@/services/congress-documents/congress-documents-service.js';
import { DocumentBodyCache } from '@/services/congress-documents/document-body-cache.js';
import { extractDocumentText } from '@/services/congress-documents/extract-text.js';
import type { DocumentContent } from '@/services/congress-documents/types.js';
import {
  CALL_BUDGET_MS,
  CLIENT_TIMEOUT_MS,
  expectBudgetTimeout,
  retryAfterResponse,
  stalledHeadersFetch,
  track,
  useFakeClock,
} from '../../helpers/budget-fixtures.js';

/** The real API client, for the cases where the format lookup's own budget is under test. */
const { CongressApiService } = await vi.importActual<
  typeof import('@/services/congress-api/congress-api-service.js')
>('@/services/congress-api/congress-api-service.js');

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

/**
 * A response whose headers arrive and whose body delivers `prefix`, then stalls.
 * The body errors only when the request's signal aborts. `onStall` fires the
 * first time the reader waits on the stalled body.
 */
function stalledBodyFetch(prefix: string, onStall?: () => void) {
  return (_url: unknown, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode(prefix));
          return;
        }
        onStall?.();
        return new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              controller.error(signal.reason);
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
  };
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

const XML_BODY =
  '<bill><section><label>SEC. 1.</label><heading>SHORT TITLE</heading><text>pre<em>formatted</em>text &amp; more</text></section><!-- note --><section><label>SEC. 2.</label><text>Second.\r\nLine two.</text></section></bill>';
const XML_TEXT = 'SEC. 1. SHORT TITLE preformattedtext & more SEC. 2. Second.\nLine two.';

/** The service's replay slice. The fixtures below place constructs across its boundaries. */
const SLICE = 128 * 1024;
const encoder = new TextEncoder();

/** Pad `prefix` with ASCII so whatever is appended next starts at byte `at` of the body. */
function padTo(prefix: string, at: number): string {
  const missing = at - encoder.encode(prefix).byteLength;
  if (missing < 0) throw new Error(`fixture already runs past byte ${at}`);
  return prefix + 'x'.repeat(missing);
}

function repeatSections(section: (i: number) => string, from: number, count: number): string {
  return Array.from({ length: count }, (_, k) => section(from + k)).join('');
}

/**
 * GPO-style Formatted Text past two replay slices: a four-byte character spans
 * the first slice boundary and an entity the second, among multi-byte text,
 * entities, and comments throughout.
 */
const PRE_SECTION = (i: number) =>
  `\nSEC. ${i}. TITLE — § ${i} costs €${i} &amp; more 𝔄.\n    Body ${i} &lt;tag&gt; &#x2014; line.<!-- note ${i} -->`;
const BIG_TEXT_BODY = `${padTo(
  `${padTo(`<html><body><pre>\n${repeatSections(PRE_SECTION, 1, 1000)}`, SLICE - 2)}𝔄${repeatSections(PRE_SECTION, 1001, 1000)}`,
  2 * SLICE - 1,
)}&amp;${repeatSections(PRE_SECTION, 2001, 500)}\n</pre></body></html>\n`;

/** No-`<pre>` XML past two replay slices: a tag spans the first boundary, a three-byte character the second. */
const XML_SECTION = (i: number) =>
  `<section id="s${i}"><num>${i}.</num><heading>Título — ${i}</heading><text>Amount &amp; €${i} <em>em</em>phasis 𝔄</text></section><!-- c${i} -->`;
const BIG_XML_BODY = `${padTo(
  `${padTo(`<?xml version="1.0"?><bill>${repeatSections(XML_SECTION, 1, 700)}`, SLICE - 3)}<note>straddle</note>${repeatSections(XML_SECTION, 701, 700)}`,
  2 * SLICE - 2,
)}€${repeatSections(XML_SECTION, 1401, 300)}</bill>`;

const URL_REPORT = 'https://www.congress.gov/118/crpt/hrpt121/generated/CRPT-118hrpt121.htm';
const URL_XML = 'https://www.congress.gov/116/bills/hr133/BILLS-116hr133enr.xml';

/** Serve each document by path, streamed in chunks that never line up with a replay slice. */
function serveDocuments(documents: Map<string, { body: string; type: string }>) {
  return (url: string | URL): Promise<Response> => {
    const parsed = new URL(String(url));
    const document =
      parsed.hostname === 'www.congress.gov' ? documents.get(parsed.pathname) : undefined;
    if (!document) return Promise.resolve(errorResponse(404));
    return Promise.resolve(streamedResponse(document.body, document.type, 4093));
  };
}

const DOCUMENTS = new Map([
  [new URL(URL_BILL).pathname, { body: preDoc(LONG_TEXT), type: 'text/html' }],
  [new URL(URL_REPORT).pathname, { body: BIG_TEXT_BODY, type: 'text/html' }],
  [new URL(URL_XML).pathname, { body: BIG_XML_BODY, type: 'application/xml' }],
]);

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
    it('preserves in-flight caller cancellation without retrying', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
            queueMicrotask(() => controller.abort());
          }),
      );
      await expect(
        service.fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          { ...createMockContext(), signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('does not retry an upstream 501 declared non-retryable', async () => {
      mockFetch.mockImplementation(() => errorResponse(501));
      await expect(
        service.fetchDocument(
          { url: URL_BILL, characterOffset: 0, characterLimit: 100 },
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'document_fetch_failed', retryable: false },
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

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
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
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
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
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

  describe('XML sibling windows', () => {
    it('returns corrected text and exact metadata across arbitrary stream chunks', async () => {
      for (const chunkSize of [1, 2, 5, 17, 256]) {
        mockFetch.mockResolvedValueOnce(streamedResponse(XML_BODY, 'application/xml', chunkSize));
        const result = await service.fetchDocument(
          { url: URL_BILL, characterOffset: 9, characterLimit: 21 },
          createMockContext(),
        );
        expect(result).toEqual({
          text: XML_TEXT.slice(9, 30),
          totalCharacters: XML_TEXT.length,
          offset: 9,
          truncated: true,
          nextOffset: 30,
        });
      }
    });

    it('walks multiple windows through the final partial window without gaps', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(streamedResponse(XML_BODY, 'application/xml', 3)),
      );
      const windows: string[] = [];
      let offset: number | null = 0;

      while (offset !== null) {
        const page = await service.fetchDocument(
          { url: URL_BILL, characterOffset: offset, characterLimit: 11 },
          createMockContext(),
        );
        expect(page.offset).toBe(offset);
        expect(page.totalCharacters).toBe(XML_TEXT.length);
        windows.push(page.text);
        offset = page.nextOffset;
      }

      expect(windows.join('')).toBe(XML_TEXT);
      expect(windows.at(-1)?.length).toBeLessThan(11);
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

    /** Each page scans the full document; give each independent window its own test. */
    it.each(Array.from({ length: Math.ceil(reference.length / 250_000) }, (_, i) => i * 250_000))(
      'returns exact text and continuation for window at %i',
      async (offset) => {
        const end = Math.min(offset + 250_000, reference.length);
        const page = await service.fetchDocument(
          { url: URL_BILL, characterOffset: offset, characterLimit: 250_000 },
          createMockContext(),
        );

        expect(page).toEqual({
          text: reference.slice(offset, end),
          totalCharacters: reference.length,
          offset,
          truncated: end < reference.length,
          nextOffset: end < reference.length ? end : null,
        });
      },
    );

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

  /**
   * One budget covers every upstream request a `content` call makes. It runs
   * from the call's start, so whatever the handler spent before the document
   * fetch — the format lookup — is already gone from it.
   */
  describe('call budget', () => {
    const window = { url: URL_BILL, characterOffset: 0, characterLimit: 100 };

    beforeEach(() => useFakeClock());
    afterEach(() => vi.useRealTimers());

    it('retries a transient failure and serves the fast second attempt', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(503))
        .mockImplementationOnce(() => Promise.resolve(streamedResponse(preDoc('Hello.'))));
      const call = track(service.fetchDocument(window, createMockContext()));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(call.state.error).toBeUndefined();
      expect(call.state.value?.text).toBe('Hello.');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['headers never arrive', () => stalledHeadersFetch],
      ['the body stalls after its headers', () => stalledBodyFetch(preDoc('SEC. 1.'))],
    ])('fails inside the budget when %s on every attempt', async (_label, fixture) => {
      mockFetch.mockImplementation(fixture());
      const ctx = createMockContext();
      const start = Date.now();
      const call = track(service.fetchDocument(window, ctx));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expect(call.state.settledAt, 'settled before the client timeout').toBeDefined();
      const elapsed = (call.state.settledAt as number) - start;
      expect(elapsed).toBeLessThanOrEqual(CALL_BUDGET_MS);
      /** The first attempt's own 30 s timeout ended at 30 s; the budget ended the second. */
      expect(elapsed).toBeGreaterThan(30_000);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'upstream_timeout', budgetMs: CALL_BUDGET_MS, retryAttempts: 2 },
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('charges time the call already spent and clamps the attempt to what is left', async () => {
      mockFetch.mockImplementation(stalledHeadersFetch);
      const ctx = createMockContext();
      const start = Date.now();
      /** The handler's format lookup took 40 s before the document fetch began. */
      await vi.advanceTimersByTimeAsync(40_000);
      const call = track(service.fetchDocument(window, ctx));
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS - 40_000);

      expect(call.state.settledAt).toBe(start + CALL_BUDGET_MS);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'upstream_timeout', retryAttempts: 1 },
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('sends nothing once the budget is spent', async () => {
      mockFetch.mockImplementation(() => Promise.resolve(streamedResponse(preDoc('Hello.'))));
      const ctx = createMockContext();
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);
      const error = (await service.fetchDocument(window, ctx).catch((e: unknown) => e)) as McpError;
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'upstream_timeout', budgetMs: CALL_BUDGET_MS, retryAttempts: 0 },
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('ends as RequestCancelled when the caller aborts mid-body, without retrying', async () => {
      const controller = new AbortController();
      const { promise: bodyStalled, resolve: stalled } = Promise.withResolvers<void>();
      mockFetch.mockImplementation(stalledBodyFetch(preDoc('SEC. 1.'), stalled));
      const call = service
        .fetchDocument(window, { ...createMockContext(), signal: controller.signal })
        .catch((e: unknown) => e);
      await bodyStalled;
      controller.abort();
      expect(await call).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('stops at once when the caller aborts during a backoff', async () => {
      const controller = new AbortController();
      mockFetch.mockResolvedValue(errorResponse(503));
      const call = track(
        service.fetchDocument(window, { ...createMockContext(), signal: controller.signal }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledOnce();
      controller.abort();
      await call.done;
      /** The abort reason itself; the handler factory reports it as RequestCancelled (below). */
      expect(call.state.error).toMatchObject({ name: 'AbortError' });
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  /**
   * The wiring of each tool's `content` branch: the budget runs from the tool
   * call's start, so a slow format lookup leaves the document fetch less time
   * rather than adding to the total.
   */
  describe('call budget through each tool', () => {
    const api = {
      getBillSubResource: vi.fn(),
      getCommitteeReportText: vi.fn(),
      getDailyArticles: vi.fn(),
    };
    const LOOKUP_MS = 20_000;
    const timeoutHint = congressErrorContracts.find(
      (entry) => entry.reason === 'upstream_timeout',
    )?.recovery;

    /** An API lookup that answers after {@link LOOKUP_MS} of fake time. */
    function slowLookup<T>(value: T) {
      return () =>
        new Promise<T>((resolve) => {
          setTimeout(() => resolve(value), LOOKUP_MS);
        });
    }

    const formats = [{ type: 'Formatted Text', url: URL_BILL }];
    const cases = [
      {
        name: 'congressgov_bill_lookup',
        run: () =>
          runToolContract(billLookupTool, {
            operation: 'content',
            congress: 119,
            billType: 'hr',
            billNumber: 1,
          }),
        arrange: () =>
          api.getBillSubResource.mockImplementation(
            slowLookup({
              data: [{ type: 'Enrolled Bill', formats }],
              pagination: { count: 1, nextOffset: null },
            }),
          ),
      },
      {
        name: 'congressgov_committee_reports',
        run: () =>
          runToolContract(committeeReportsTool, {
            operation: 'content',
            congress: 118,
            reportType: 'hrpt',
            reportNumber: 1,
          }),
        arrange: () =>
          api.getCommitteeReportText.mockImplementation(slowLookup({ text: [{ formats }] })),
      },
      {
        name: 'congressgov_daily_record',
        run: () =>
          runToolContract(dailyRecordTool, {
            operation: 'content',
            volumeNumber: 169,
            issueNumber: 109,
          }),
        arrange: () =>
          api.getDailyArticles.mockImplementation(
            slowLookup({
              data: [{ title: 'Article', text: formats }],
              pagination: { count: 1, nextOffset: null },
            }),
          ),
      },
    ];

    beforeEach(() => {
      useFakeClock();
      vi.mocked(getCongressApi).mockReturnValue(api as never);
      initCongressDocuments();
    });
    afterEach(() => vi.useRealTimers());

    it.each(cases)(
      '$name settles inside the budget after a slow lookup and a stalled document',
      async ({ arrange, run }) => {
        arrange();
        mockFetch.mockImplementation(stalledHeadersFetch);
        const start = Date.now();
        const call = track(run());
        await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

        expectBudgetTimeout(call, start, { hint: timeoutHint });
        /** 20 s of lookup leaves 30 s, which the first attempt uses up; no second attempt fits. */
        expect(mockFetch).toHaveBeenCalledOnce();
      },
    );

    it('bounds the format lookup itself: a lookup that would run past the budget ends at it, and no document is requested', async () => {
      vi.mocked(getCongressApi).mockReturnValue(new CongressApiService());
      const hits = { api: 0, document: 0 };
      mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
        if (new URL(String(url)).hostname === 'api.congress.gov') {
          /** The lookup is asked to wait 30 s, then stalls on every later attempt. */
          return hits.api++ === 0
            ? Promise.resolve(retryAfterResponse(503, 30))
            : stalledHeadersFetch(url, init);
        }
        hits.document++;
        return stalledHeadersFetch(url, init);
      });
      const start = Date.now();
      const call = track(cases[0]!.run());
      await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);

      expectBudgetTimeout(call, start, {
        hint: 'Retry after a short delay; the Congress.gov service may be temporarily degraded.',
      });
      /** The lookup's expiry, in the API client's own words, before any document request. */
      expect(call.state.value?.structuredContent).toMatchObject({
        error: {
          message:
            "Congress.gov did not deliver the API response within this call's 50-second budget for upstream requests (3 attempts).",
        },
      });
      expect(hits).toEqual({ api: 3, document: 0 });
    });

    it('reports a caller abort during a backoff as RequestCancelled on both surfaces', async () => {
      api.getCommitteeReportText.mockResolvedValue({ text: [{ formats }] });
      mockFetch.mockResolvedValue(errorResponse(503));
      const controller = new AbortController();
      const call = track(
        runToolContract(
          committeeReportsTool,
          { operation: 'content', congress: 118, reportType: 'hrpt', reportNumber: 1 },
          { context: { signal: controller.signal } },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledOnce();
      controller.abort();
      await call.done;
      expect(call.state.value?.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(call.state.value?.isError).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  /**
   * A multi-window document is fetched once per TTL: its decompressed body is
   * cached and later windows replay it through the same extractor.
   */
  describe('body cache', () => {
    const read = (
      target: CongressDocumentsService,
      url: string,
      characterOffset: number,
      characterLimit = 25_000,
      signal?: AbortSignal,
    ) =>
      target.fetchDocument(
        { url, characterOffset, characterLimit },
        signal ? { ...createMockContext(), signal } : createMockContext(),
      );

    /** Walk a whole document via nextOffset on one service. */
    async function walk(target: CongressDocumentsService, url: string, limit: number) {
      const pages: DocumentContent[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        if (pages.length > 500) throw new Error('walk did not terminate');
        const page: DocumentContent = await read(target, url, offset, limit);
        pages.push(page);
        offset = page.nextOffset;
      }
      return pages;
    }

    beforeEach(() => {
      mockFetch.mockImplementation(serveDocuments(DOCUMENTS));
    });
    afterEach(() => vi.useRealTimers());

    it('places a construct across each replay slice boundary', () => {
      const text = encoder.encode(BIG_TEXT_BODY);
      expect(text.byteLength).toBeGreaterThan(2 * SLICE);
      /** Mid-character: a UTF-8 continuation byte sits at each boundary. */
      expect(text[SLICE]! & 0xc0).toBe(0x80);
      expect(new TextDecoder().decode(text.subarray(2 * SLICE - 1, 2 * SLICE + 4))).toBe('&amp;');
      const xml = encoder.encode(BIG_XML_BODY);
      expect(xml.byteLength).toBeGreaterThan(2 * SLICE);
      expect(new TextDecoder().decode(xml.subarray(SLICE - 3, SLICE + 3))).toBe('<note>');
      expect(xml[2 * SLICE]! & 0xc0).toBe(0x80);
    });

    it.each([
      ['Formatted Text', URL_REPORT, BIG_TEXT_BODY],
      ['XML', URL_XML, BIG_XML_BODY],
    ])(
      'serves a %s walk from one fetch, identical to per-window fetches',
      async (_label, url, body) => {
        const pages = await walk(service, url, 25_000);
        expect(mockFetch).toHaveBeenCalledOnce();
        expect(pages.length).toBeGreaterThan(5);
        expect(pages.map((page) => page.text).join('')).toBe(extractDocumentText(body));

        for (const page of pages) {
          const fresh = await read(new CongressDocumentsService(ROOMY), url, page.offset);
          expect(page, `window at ${page.offset}`).toEqual(fresh);
        }
        expect(mockFetch).toHaveBeenCalledTimes(1 + pages.length);
      },
    );

    it('serves the same window on a fresh instance and after priming calls on other documents', async () => {
      const fresh = await read(new CongressDocumentsService(ROOMY), URL_REPORT, 50_000);
      await read(service, URL_XML, 0);
      await read(service, URL_BILL, 0, 100);
      await read(service, URL_REPORT, 0);
      const fetches = mockFetch.mock.calls.length;
      const fromCache = await read(service, URL_REPORT, 50_000);
      expect(mockFetch).toHaveBeenCalledTimes(fetches);
      expect(fromCache).toEqual(fresh);
    });

    it('fetches once while the entry lives and once more after it expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      await read(service, URL_BILL, 0, 100);
      await read(service, URL_BILL, 100, 100);
      expect(mockFetch).toHaveBeenCalledOnce();

      vi.setSystemTime(start + 10 * 60_000 - 1);
      await read(service, URL_BILL, 200, 100);
      expect(mockFetch).toHaveBeenCalledOnce();

      vi.setSystemTime(start + 10 * 60_000);
      await read(service, URL_BILL, 300, 100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await read(service, URL_BILL, 400, 100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('caches nothing for a single-window document, which fetches each time as before', async () => {
      await read(service, URL_BILL, 0, LONG_TEXT.length);
      await read(service, URL_BILL, 0, LONG_TEXT.length);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('caches nothing from a window that reaches the end, even of a long document', async () => {
      await read(service, URL_BILL, LONG_TEXT.length - 50, 100);
      await read(service, URL_BILL, 0, 100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await read(service, URL_BILL, 100, 100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('never caches a body past the entry ceiling, and caches one exactly at it', async () => {
      const bytes = encoder.encode(preDoc(LONG_TEXT)).byteLength;
      const limits = { maxBytes: 10 * bytes, ttlMs: 10 * 60_000 };
      const over = new CongressDocumentsService(
        ROOMY,
        new DocumentBodyCache({ ...limits, maxEntryBytes: bytes - 1 }),
      );
      await read(over, URL_BILL, 0, 100);
      await read(over, URL_BILL, 100, 100);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const at = new CongressDocumentsService(
        ROOMY,
        new DocumentBodyCache({ ...limits, maxEntryBytes: bytes }),
      );
      await read(at, URL_BILL, 0, 100);
      await read(at, URL_BILL, 100, 100);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('caches nothing from a cancelled read', async () => {
      const controller = new AbortController();
      const { promise: bodyStalled, resolve: stalled } = Promise.withResolvers<void>();
      mockFetch.mockImplementationOnce(stalledBodyFetch(preDoc(LONG_TEXT), stalled));
      const cancelled = read(service, URL_BILL, 0, 100, controller.signal).catch((e: unknown) => e);
      await bodyStalled;
      controller.abort();
      expect(await cancelled).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });

      const page = await read(service, URL_BILL, 0, 100);
      expect(page.text).toBe(LONG_TEXT.slice(0, 100));
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await read(service, URL_BILL, 100, 100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('stops a cancelled replay at its next yield, without fetching', async () => {
      await read(service, URL_REPORT, 0);
      const controller = new AbortController();
      const replay = read(service, URL_REPORT, 25_000, 25_000, controller.signal).catch(
        (e: unknown) => e,
      );
      controller.abort();
      expect(await replay).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('stops a cancelled replay at the first yield after the abort, not after the whole body', async () => {
      await read(service, URL_REPORT, 0);
      const controller = new AbortController();
      const yields = vi.spyOn(globalThis, 'setImmediate');
      try {
        const replay = read(service, URL_REPORT, 25_000, 25_000, controller.signal).catch(
          (e: unknown) => e,
        );
        controller.abort();
        expect(await replay).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        /** The body spans three replay slices; the abort lands before the first yield returns. */
        expect(yields).toHaveBeenCalledTimes(1);
      } finally {
        yields.mockRestore();
      }
    });

    it("keeps one caller's cancelled replay from failing another's", async () => {
      await read(service, URL_REPORT, 0);
      const reference = extractDocumentText(BIG_TEXT_BODY);
      const controller = new AbortController();
      const cancelled = read(service, URL_REPORT, 25_000, 25_000, controller.signal).catch(
        (e: unknown) => e,
      );
      const other = read(service, URL_REPORT, 25_000);
      controller.abort();
      expect(await cancelled).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect((await other).text).toBe(reference.slice(25_000, 50_000));
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("fetches concurrent cold reads separately, and one's cancellation leaves the other whole", async () => {
      const controller = new AbortController();
      const { promise: bodyStalled, resolve: stalled } = Promise.withResolvers<void>();
      mockFetch.mockImplementationOnce(stalledBodyFetch(preDoc(LONG_TEXT), stalled));
      const cancelled = read(service, URL_BILL, 0, 100, controller.signal).catch((e: unknown) => e);
      await bodyStalled;
      /** Both reads are cold and in flight: the first is stalled mid-body. */
      const other = read(service, URL_BILL, 0, 100);
      controller.abort();
      expect(await cancelled).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect((await other).text).toBe(LONG_TEXT.slice(0, 100));
      expect(mockFetch).toHaveBeenCalledTimes(2);
      /** The read that finished cached the body for later windows. */
      await read(service, URL_BILL, 100, 100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('serves a cached window without the budget, even once the budget is spent', async () => {
      await read(service, URL_BILL, 0, 100);
      useFakeClock();
      const ctx = createMockContext();
      await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);
      mockFetch.mockImplementation(stalledHeadersFetch);
      const page = await service.fetchDocument(
        { url: URL_BILL, characterOffset: 100, characterLimit: 100 },
        ctx,
      );
      expect(page.text).toBe(LONG_TEXT.slice(100, 200));
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('singleton', () => {
    it('initializes and returns the service', () => {
      expect(() => initCongressDocuments()).not.toThrow();
      expect(() => getCongressDocuments()).not.toThrow();
    });
  });
});
