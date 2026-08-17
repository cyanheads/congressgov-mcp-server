/**
 * @fileoverview Tests for the `content` operation on congressgov_bill_lookup,
 * congressgov_committee_reports, and congressgov_daily_record — the bounded
 * document-text path added by cyanheads/congressgov-mcp-server#53.
 *
 * Covers both client surfaces (structuredContent and the format()-rendered
 * content[]), the selection of one document out of the upstream format
 * metadata, every declared error contract with its recovery hint, and the
 * window boundaries: empty document, final partial window, and a walk driven by
 * nextOffset that must reassemble the source exactly.
 *
 * @module tests/mcp-server/tools/definitions/document-content.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));
vi.mock('@/services/congress-documents/congress-documents-service.js', () => ({
  getCongressDocuments: vi.fn(),
  initCongressDocuments: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { getCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import type { DocumentContent } from '@/services/congress-documents/types.js';

const HTM = 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.htm';
const USLM = 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr_uslm.xml';
const CRPT = 'https://www.congress.gov/118/crpt/hrpt1/generated/CRPT-118hrpt1.htm';
const CREC = 'https://www.congress.gov/118/crec/2023/06/22/169/109/CREC-PgD655.htm';

const BILL_FORMATS = [
  { type: 'Formatted Text', url: HTM },
  { type: 'PDF', url: 'https://www.congress.gov/119/bills/hr1/BILLS-119hr1enr.pdf' },
  { type: 'United States Legislative Markup', url: USLM },
];

const mockApi = {
  getBillSubResource: vi.fn(),
  getCommitteeReportText: vi.fn(),
  getDailyArticles: vi.fn(),
};
const mockDocuments = { fetchDocument: vi.fn() };

/** A whole document the fakes slice exactly the way the real service does. */
const DOC_TEXT = Array.from(
  { length: 12 },
  (_, i) => `SEC. ${i + 1}. HEADING ${i + 1}.\n\n    Body of section ${i + 1}.`,
).join('\n\n');

/** Stand-in for CongressDocumentsService.fetchDocument, with the same window contract. */
function fakeFetch(text: string) {
  return vi.fn(
    async ({
      characterOffset,
      characterLimit,
    }: {
      characterOffset: number;
      characterLimit: number;
    }): Promise<DocumentContent> => {
      const slice = text.slice(characterOffset, characterOffset + characterLimit);
      const end = characterOffset + slice.length;
      const truncated = end < text.length;
      return {
        text: slice,
        totalCharacters: text.length,
        offset: characterOffset,
        truncated,
        nextOffset: truncated ? end : null,
      };
    },
  );
}

/**
 * The McpError a handler rejects with, failing loudly if it resolves instead.
 * A tool handler's declared return type is `Promise<T> | T`, so `.catch` is not
 * on it — resolve first, then split the outcome.
 */
async function failureOf(call: unknown): Promise<McpError> {
  const outcome = await Promise.resolve(call).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (outcome === undefined) throw new Error('Expected the handler to reject, but it resolved.');
  return outcome as McpError;
}

/** Join a formatter's blocks into the single string a content[]-only client sees. */
function joinText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.map((b) => b.text ?? '').join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCongressApi).mockReturnValue(mockApi as never);
  vi.mocked(getCongressDocuments).mockReturnValue(mockDocuments as never);
  mockDocuments.fetchDocument = fakeFetch(DOC_TEXT);
});

describe('congressgov_bill_lookup — content', () => {
  beforeEach(() => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ type: 'Enrolled Bill', date: null, formats: BILL_FORMATS }],
      pagination: { count: 6, nextOffset: null },
    });
  });

  it('carries the window on structuredContent and content[] alike', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      characterLimit: 60,
    });
    const result = await billLookupTool.handler(input, ctx);
    const content = result.content as Record<string, unknown>;

    expect(content).toMatchObject({
      text: DOC_TEXT.slice(0, 60),
      totalCharacters: DOC_TEXT.length,
      offset: 0,
      truncated: true,
      nextOffset: 60,
      format: 'text',
      sourceUrl: HTM,
      documentTitle: 'HR 1 — Enrolled Bill',
    });

    const rendered = joinText(billLookupTool.format!(result));
    expect(rendered).toContain('# HR 1 — Enrolled Bill');
    expect(rendered).toContain('**Format:** text');
    expect(rendered).toContain(`of ${DOC_TEXT.length.toLocaleString('en-US')}`);
    expect(rendered).toContain('**Truncated:** true');
    expect(rendered).toContain('next offset: 60');
    expect(rendered).toContain(`**Source:** ${HTM}`);
    /** The document text itself reaches the content[]-only client, verbatim. */
    expect(rendered).toContain(DOC_TEXT.slice(0, 60));
  });

  it('populates both required enrichment fields', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
    });
    await billLookupTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(DOC_TEXT.length);
    expect(String(enrichment.effectiveQuery)).toContain('Enrolled Bill');
  });

  it('fetches exactly the selected text version, one upstream row', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      textVersionIndex: 3,
    });
    await billLookupTool.handler(input, ctx);
    expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'text', limit: 1, offset: 3 }),
      ctx,
    );
  });

  it("resolves format 'xml' to the USLM url", async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      format: 'xml',
    });
    const result = await billLookupTool.handler(input, ctx);
    expect((result.content as Record<string, unknown>).sourceUrl).toBe(USLM);
    expect(mockDocuments.fetchDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: USLM }),
      ctx,
    );
  });

  it('passes the character window through to the document service unchanged', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      characterOffset: 12,
      characterLimit: 34,
    });
    await billLookupTool.handler(input, ctx);
    expect(mockDocuments.fetchDocument).toHaveBeenCalledWith(
      { url: HTM, characterOffset: 12, characterLimit: 34 },
      ctx,
    );
  });

  it('fails with document_unavailable when the version index is past the end', async () => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [],
      pagination: { count: 6, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      textVersionIndex: 99,
    });
    const error = await failureOf(billLookupTool.handler(input, ctx));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('document_unavailable');
    expect(error.data?.available).toBe(6);
    expect(error.data?.recovery).toMatchObject({ hint: expect.stringContaining('articles') });
    expect(mockDocuments.fetchDocument).not.toHaveBeenCalled();
  });

  /**
   * `/bill/{c}/{t}/{n}/text` appends the "Public Law" version to every page of an
   * enacted bill's list, so an out-of-range offset comes back holding that row
   * rather than empty. Selecting `data[0]` alone would serve the Public Law text
   * for any index past the end — a different document than the caller asked for,
   * with nothing in the response saying so.
   */
  it('fails with document_unavailable when an out-of-range index still returns a row', async () => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ type: 'Public Law', formats: BILL_FORMATS }],
      pagination: { count: 6, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      textVersionIndex: 6,
    });
    const error = await failureOf(billLookupTool.handler(input, ctx));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('document_unavailable');
    expect(error.data?.available).toBe(6);
    expect(mockDocuments.fetchDocument).not.toHaveBeenCalled();
  });

  it('serves the last version at the highest in-range index', async () => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ type: 'Public Law', formats: BILL_FORMATS }],
      pagination: { count: 6, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      textVersionIndex: 5,
    });
    const result = await billLookupTool.handler(input, ctx);
    expect((result.content as Record<string, unknown>).documentTitle).toBe('HR 1 — Public Law');
  });

  it('fails with format_unavailable on a PDF-only version', async () => {
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ type: 'Introduced in House', formats: [{ type: 'PDF', url: 'https://x/a.pdf' }] }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
    });
    const error = await failureOf(billLookupTool.handler(input, ctx));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('format_unavailable');
    expect(error.data?.recovery).toMatchObject({ hint: expect.any(String) });
    expect(error.message).toContain('Formatted Text');
    expect(mockDocuments.fetchDocument).not.toHaveBeenCalled();
  });

  it('requires billType and billNumber like every other sub-resource', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({ operation: 'content', congress: 119 });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  it('surfaces a document-service failure unchanged', async () => {
    const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
    mockDocuments.fetchDocument = vi.fn().mockRejectedValue(
      serviceUnavailable('Unable to retrieve the document from Congress.gov.', {
        reason: 'document_fetch_failed',
      }),
    );
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
    });
    const error = await failureOf(billLookupTool.handler(input, ctx));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('document_fetch_failed');
  });

  it('walks the document via nextOffset and reassembles it exactly', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const chunks: string[] = [];
    let offset: number | null = 0;
    let guard = 0;

    while (offset !== null) {
      if (++guard > 100) throw new Error('walk did not terminate');
      const input = billLookupTool.input.parse({
        operation: 'content',
        congress: 119,
        billType: 'hr',
        billNumber: 1,
        characterOffset: offset,
        characterLimit: 50,
      });
      const page = await billLookupTool.handler(input, ctx);
      const content = page.content as unknown as DocumentContent;
      expect(content.offset).toBe(offset);
      chunks.push(content.text);
      offset = content.nextOffset;
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(DOC_TEXT);
  });
});

describe('congressgov_committee_reports — content', () => {
  beforeEach(() => {
    mockApi.getCommitteeReportText.mockResolvedValue({
      text: [
        { formats: [{ isErrata: 'N', type: 'Formatted Text', url: CRPT }] },
        { formats: [{ isErrata: 'N', type: 'PDF', url: 'https://www.congress.gov/a.pdf' }] },
      ],
    });
  });

  it('flattens formats across text entries and renders both surfaces', async () => {
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({
      operation: 'content',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 1,
      characterLimit: 40,
    });
    const result = await committeeReportsTool.handler(input, ctx);
    const content = result.content as Record<string, unknown>;

    expect(content).toMatchObject({
      sourceUrl: CRPT,
      format: 'text',
      documentTitle: 'Committee Report HRPT 118-1',
      offset: 0,
      truncated: true,
    });
    const rendered = joinText(committeeReportsTool.format!(result));
    expect(rendered).toContain('# Committee Report HRPT 118-1');
    expect(rendered).toContain(DOC_TEXT.slice(0, 40));
    expect(getEnrichment(ctx).totalCount).toBe(DOC_TEXT.length);
  });

  it('prefers the non-errata printing', async () => {
    mockApi.getCommitteeReportText.mockResolvedValue({
      text: [
        {
          formats: [
            { isErrata: 'Y', type: 'Formatted Text', url: 'https://www.congress.gov/e.htm' },
          ],
        },
        { formats: [{ isErrata: 'N', type: 'Formatted Text', url: CRPT }] },
      ],
    });
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({
      operation: 'content',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 1,
    });
    const result = await committeeReportsTool.handler(input, ctx);
    expect((result.content as Record<string, unknown>).sourceUrl).toBe(CRPT);
  });

  it('fails with format_unavailable for xml, which committee reports never publish', async () => {
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({
      operation: 'content',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 1,
      format: 'xml',
    });
    const error = await failureOf(committeeReportsTool.handler(input, ctx));
    expect(error.data?.reason).toBe('format_unavailable');
    expect(error.data?.recovery).toMatchObject({ hint: expect.any(String) });
    expect(error.message).toContain('United States Legislative Markup / Formatted XML');
  });

  it('fails with document_unavailable when the report publishes no formats', async () => {
    mockApi.getCommitteeReportText.mockResolvedValue({ text: [] });
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({
      operation: 'content',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 1,
    });
    const error = await failureOf(committeeReportsTool.handler(input, ctx));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('document_unavailable');
  });

  it('requires reportType and reportNumber', async () => {
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({ operation: 'content', congress: 118 });
    await expect(committeeReportsTool.handler(input, ctx)).rejects.toThrow(/'content' operation/);
  });
});

describe('congressgov_daily_record — content', () => {
  beforeEach(() => {
    mockApi.getDailyArticles.mockResolvedValue({
      data: [
        {
          sectionName: 'Daily Digest',
          title: 'COMMITTEE MEETINGS; Congressional Record Vol. 169, No. 109',
          text: [
            { type: 'Formatted Text', url: CREC },
            { type: 'PDF', url: 'https://www.congress.gov/a.pdf' },
          ],
        },
      ],
      pagination: { count: 245, nextOffset: 4 },
    });
  });

  it('selects the article by absolute index and renders both surfaces', async () => {
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    const input = dailyRecordTool.input.parse({
      operation: 'content',
      volumeNumber: 169,
      issueNumber: 109,
      articleIndex: 3,
      characterLimit: 30,
    });
    const result = await dailyRecordTool.handler(input, ctx);

    expect(mockApi.getDailyArticles).toHaveBeenCalledWith(
      { volumeNumber: 169, issueNumber: 109, limit: 1, offset: 3 },
      ctx,
    );
    const content = result.content as Record<string, unknown>;
    expect(content).toMatchObject({
      sourceUrl: CREC,
      documentTitle: 'COMMITTEE MEETINGS; Congressional Record Vol. 169, No. 109',
    });
    const rendered = joinText(dailyRecordTool.format!(result));
    expect(rendered).toContain('COMMITTEE MEETINGS');
    expect(rendered).toContain(DOC_TEXT.slice(0, 30));
    expect(getEnrichment(ctx).totalCount).toBe(DOC_TEXT.length);
  });

  it('accepts the digit-string identifiers list rows carry', async () => {
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    const input = dailyRecordTool.input.parse({
      operation: 'content',
      volumeNumber: '169',
      issueNumber: '109',
    });
    await dailyRecordTool.handler(input, ctx);
    expect(mockApi.getDailyArticles).toHaveBeenCalledWith(
      expect.objectContaining({ volumeNumber: 169, issueNumber: 109 }),
      ctx,
    );
  });

  it('falls back to a positional title when the article has none', async () => {
    mockApi.getDailyArticles.mockResolvedValue({
      data: [{ text: [{ type: 'Formatted Text', url: CREC }] }],
      pagination: { count: 245, nextOffset: null },
    });
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    const input = dailyRecordTool.input.parse({
      operation: 'content',
      volumeNumber: 169,
      issueNumber: 109,
      articleIndex: 7,
    });
    const result = await dailyRecordTool.handler(input, ctx);
    expect((result.content as Record<string, unknown>).documentTitle).toBe(
      'Volume 169, issue 109, article 7',
    );
  });

  it('fails with document_unavailable when the article index is past the end', async () => {
    mockApi.getDailyArticles.mockResolvedValue({
      data: [],
      pagination: { count: 245, nextOffset: null },
    });
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    const input = dailyRecordTool.input.parse({
      operation: 'content',
      volumeNumber: 169,
      issueNumber: 109,
      articleIndex: 99_999,
    });
    const error = await failureOf(dailyRecordTool.handler(input, ctx));
    expect(error.data?.reason).toBe('document_unavailable');
    expect(error.data?.available).toBe(245);
    expect(error.data?.recovery).toMatchObject({ hint: expect.any(String) });
  });

  it('fails with format_unavailable for xml', async () => {
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    const input = dailyRecordTool.input.parse({
      operation: 'content',
      volumeNumber: 169,
      issueNumber: 109,
      format: 'xml',
    });
    const error = await failureOf(dailyRecordTool.handler(input, ctx));
    expect(error.data?.reason).toBe('format_unavailable');
  });

  it('requires volumeNumber and issueNumber', async () => {
    const ctx = createMockContext({ errors: dailyRecordTool.errors });
    await expect(
      dailyRecordTool.handler(dailyRecordTool.input.parse({ operation: 'content' }), ctx),
    ).rejects.toThrow(/volumeNumber/);
    await expect(
      dailyRecordTool.handler(
        dailyRecordTool.input.parse({ operation: 'content', volumeNumber: 169 }),
        ctx,
      ),
    ).rejects.toThrow(/issueNumber/);
  });
});

describe('content rendering boundaries', () => {
  it('marks the final window as the end of the document', async () => {
    mockDocuments.fetchDocument = fakeFetch(DOC_TEXT);
    mockApi.getCommitteeReportText.mockResolvedValue({
      text: [{ formats: [{ type: 'Formatted Text', url: CRPT }] }],
    });
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({
      operation: 'content',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 1,
      characterOffset: DOC_TEXT.length - 5,
      characterLimit: 500,
    });
    const result = await committeeReportsTool.handler(input, ctx);
    const content = result.content as unknown as DocumentContent;
    expect(content.text).toBe(DOC_TEXT.slice(-5));
    expect(content.truncated).toBe(false);
    expect(content.nextOffset).toBeNull();

    const rendered = joinText(committeeReportsTool.format!(result));
    expect(rendered).toContain('**Truncated:** false');
    expect(rendered).toContain('_end of document_');
    expect(rendered).not.toContain('next offset:');
  });

  it('renders an empty document without pretending it has content', async () => {
    mockDocuments.fetchDocument = fakeFetch('');
    mockApi.getCommitteeReportText.mockResolvedValue({
      text: [{ formats: [{ type: 'Formatted Text', url: CRPT }] }],
    });
    const ctx = createMockContext({ errors: committeeReportsTool.errors });
    const input = committeeReportsTool.input.parse({
      operation: 'content',
      congress: 118,
      reportType: 'hrpt',
      reportNumber: 1,
    });
    const result = await committeeReportsTool.handler(input, ctx);
    expect(result.content as unknown as DocumentContent).toMatchObject({
      text: '',
      totalCharacters: 0,
      truncated: false,
      nextOffset: null,
    });
    const rendered = joinText(committeeReportsTool.format!(result));
    expect(rendered).toContain('**0 characters**');
    expect(rendered).toContain('_This document is empty._');
  });

  it('renders a window whose limit exceeds the remainder as the whole tail', async () => {
    mockDocuments.fetchDocument = fakeFetch(DOC_TEXT);
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ type: 'Enrolled Bill', formats: BILL_FORMATS }],
      pagination: { count: 1, nextOffset: null },
    });
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({
      operation: 'content',
      congress: 119,
      billType: 'hr',
      billNumber: 1,
      characterLimit: 100_000,
    });
    const result = await billLookupTool.handler(input, ctx);
    const content = result.content as unknown as DocumentContent;
    expect(content.text).toBe(DOC_TEXT);
    expect(content.nextOffset).toBeNull();
    /** The whole document reaches the content[]-only client, not a preview of it. */
    expect(joinText(billLookupTool.format!(result))).toContain(DOC_TEXT);
  });

  it('rejects a characterLimit above the declared ceiling at the schema', () => {
    expect(() =>
      billLookupTool.input.parse({
        operation: 'content',
        congress: 119,
        billType: 'hr',
        billNumber: 1,
        characterLimit: 100_001,
      }),
    ).toThrow();
    expect(() =>
      billLookupTool.input.parse({
        operation: 'content',
        congress: 119,
        billType: 'hr',
        billNumber: 1,
        characterOffset: -1,
      }),
    ).toThrow();
  });
});
