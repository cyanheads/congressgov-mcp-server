/**
 * @fileoverview Tests for congressgov_crs_reports tool.
 * @module tests/mcp-server/tools/definitions/crs-reports.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  })),
}));

import { crsReportsTool } from '@/mcp-server/tools/definitions/crs-reports.tool.js';
import { documentErrorContracts } from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { initCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';

/** Join a result's text blocks into the single string a content-only client sees. */
function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? '').join('\n');
}

describe('crsReportsTool', () => {
  const mockApi = {
    listCrsReports: vi.fn(),
    getCrsReport: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists CRS reports', async () => {
    const ctx = createMockContext({ errors: crsReportsTool.errors });
    mockApi.listCrsReports.mockResolvedValue({
      data: [{ reportNumber: 'R40097' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = crsReportsTool.input.parse({ operation: 'list' });
    const result = await crsReportsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect(mockApi.listCrsReports).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 0 }),
      ctx,
    );
  });

  it('gets a specific CRS report', async () => {
    const ctx = createMockContext({ errors: crsReportsTool.errors });
    mockApi.getCrsReport.mockResolvedValue({ report: { title: 'Climate Policy' } });
    const input = crsReportsTool.input.parse({
      operation: 'get',
      reportNumber: 'R40097',
    });
    const result = await crsReportsTool.handler(input, ctx);
    expect(result.report).toEqual({ title: 'Climate Policy' });
    expect(mockApi.getCrsReport).toHaveBeenCalledWith({ reportNumber: 'R40097' }, ctx);
  });

  it('throws when get is missing reportNumber', async () => {
    const ctx = createMockContext({ errors: crsReportsTool.errors });
    const input = crsReportsTool.input.parse({ operation: 'get' });
    await expect(crsReportsTool.handler(input, ctx)).rejects.toThrow(/reportNumber/);
  });

  it('omits the summary line entirely when sparse — never invents placeholder noise', () => {
    const output = crsReportsTool.output.parse({
      data: [{ reportNumber: 'R40097' }],
      pagination: { count: 1, nextOffset: null },
    });
    const blocks = crsReportsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('R40097');
    expect(text).not.toContain('Summary not available');
  });

  // ── #96: the report ID grammar ──

  describe('report ID grammar', () => {
    /** Every raw form the tool accepts: both ID shapes, either case, padded, and blank. */
    const ACCEPTED = [
      'R40097',
      'IF12218',
      'LSB10001',
      '96-548',
      'r40097',
      ' R40097 ',
      '\t96-548\n',
      '',
      '   ',
    ];
    const REJECTED = [
      '..',
      '.',
      '../bill/119/hr/1',
      'R40097/x',
      'R40097?format=xml',
      '%2e%2e',
      '40097',
      'R 40097',
      'R-40097',
      '96-',
      '-548',
    ];

    const advertised = () =>
      (
        z.toJSONSchema(crsReportsTool.input, { io: 'input' }) as {
          properties: Record<string, { pattern?: string; maxLength?: number }>;
        }
      ).properties.reportNumber;

    it('accepts every raw form at the schema, and so does the advertised pattern', () => {
      const pattern = advertised()?.pattern;
      expect(pattern).toEqual(expect.any(String));
      const jsonSchemaPattern = new RegExp(pattern as string);
      for (const reportNumber of ACCEPTED) {
        expect(
          crsReportsTool.input.safeParse({ operation: 'get', reportNumber }).success,
          JSON.stringify(reportNumber),
        ).toBe(true);
        expect(jsonSchemaPattern.test(reportNumber), JSON.stringify(reportNumber)).toBe(true);
      }
    });

    it('rejects every other shape at the schema, and so does the advertised pattern', () => {
      const jsonSchemaPattern = new RegExp(advertised()?.pattern as string);
      for (const reportNumber of REJECTED) {
        expect(
          crsReportsTool.input.safeParse({ operation: 'get', reportNumber }).success,
          JSON.stringify(reportNumber),
        ).toBe(false);
        expect(jsonSchemaPattern.test(reportNumber), JSON.stringify(reportNumber)).toBe(false);
      }
    });

    it('fails a path-shaped value as invalid arguments before any request', async () => {
      const result = await runToolContract(crsReportsTool, {
        operation: 'get',
        reportNumber: '../bill/119/hr/1',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(contentText(result)).toContain('reportNumber');
      expect(mockApi.getCrsReport).not.toHaveBeenCalled();
    });

    it('accepts a padded value of any length, and still browses on a whitespace-only list value', () => {
      expect(advertised()?.maxLength).toBeUndefined();
      for (const operation of ['get', 'content', 'list'] as const) {
        const reportNumber = operation === 'list' ? ' '.repeat(200) : 'R40097'.padStart(200);
        expect(crsReportsTool.input.safeParse({ operation, reportNumber }).success, operation).toBe(
          true,
        );
      }
    });

    it.each(['R40097', '96-548'])('requests %s unchanged', async (reportNumber) => {
      mockApi.getCrsReport.mockResolvedValue({ report: { id: reportNumber } });
      const result = await runToolContract(crsReportsTool, { operation: 'get', reportNumber });
      expect(result.isError).not.toBe(true);
      expect(mockApi.getCrsReport).toHaveBeenCalledWith({ reportNumber }, expect.anything());
      expect(result.structuredContent).toMatchObject({
        effectiveQuery: `CRS report ${reportNumber}`,
      });
    });

    it.each(['r40097', ' R40097 ', '\tr40097\n'])(
      'requests %j as R40097 and echoes the normalized ID on both surfaces',
      async (reportNumber) => {
        mockApi.getCrsReport.mockResolvedValue({ report: { id: 'R40097', title: 'Climate' } });
        const result = await runToolContract(crsReportsTool, { operation: 'get', reportNumber });
        expect(result.isError).not.toBe(true);
        expect(mockApi.getCrsReport).toHaveBeenCalledWith(
          { reportNumber: 'R40097' },
          expect.anything(),
        );
        expect(result.structuredContent).toMatchObject({ effectiveQuery: 'CRS report R40097' });
        expect(contentText(result)).toContain('CRS report R40097');
      },
    );

    it('answers a whitespace-only reportNumber on get with the requires error, before any request', async () => {
      const ctx = createMockContext({ errors: crsReportsTool.errors });
      const input = crsReportsTool.input.parse({ operation: 'get', reportNumber: '   ' });
      await expect(crsReportsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('requires reportNumber'),
        data: { field: 'reportNumber' },
      });
      expect(mockApi.getCrsReport).not.toHaveBeenCalled();
    });

    it('names both ID shapes in the requires error', async () => {
      const ctx = createMockContext({ errors: crsReportsTool.errors });
      const input = crsReportsTool.input.parse({ operation: 'get' });
      await expect(crsReportsTool.handler(input, ctx)).rejects.toThrow(/R40097.*96-548/);
    });

    it('names both ID shapes in the tool and field descriptions', () => {
      expect(crsReportsTool.description).toContain('96-548');
      expect(advertised()).toMatchObject({ description: expect.stringContaining('96-548') });
    });
  });

  // ── #103: the update-date filters ──

  describe('update-date filters', () => {
    const FROM = '2026-10-01T00:00:00Z';
    const TO = '2026-10-31T23:59:59Z';
    const page = {
      data: [{ id: 'IN12345', title: 'Revised Insight', updateDate: '2026-10-14T12:00:00Z' }],
      pagination: { count: 727, nextOffset: 1 },
    };

    it('sends both bounds on list and echoes them on both surfaces', async () => {
      mockApi.listCrsReports.mockResolvedValue(structuredClone(page));
      const result = await runToolContract(crsReportsTool, {
        operation: 'list',
        fromDateTime: FROM,
        toDateTime: TO,
        limit: 1,
      });
      expect(result.isError).not.toBe(true);
      expect(mockApi.listCrsReports).toHaveBeenCalledWith(
        { limit: 1, offset: 0, fromDateTime: FROM, toDateTime: TO },
        expect.anything(),
      );
      const echo = `CRS reports (fromDateTime=${FROM}, toDateTime=${TO})`;
      expect(result.structuredContent).toMatchObject({
        ...page,
        effectiveQuery: echo,
        totalCount: 727,
      });
      expect(contentText(result)).toContain(echo);
      expect(contentText(result)).toContain('IN12345');
    });

    it('sends one bound alone', async () => {
      mockApi.listCrsReports.mockResolvedValue(structuredClone(page));
      await runToolContract(crsReportsTool, { operation: 'list', toDateTime: TO });
      expect(mockApi.listCrsReports).toHaveBeenCalledWith(
        { limit: 20, offset: 0, toDateTime: TO },
        expect.anything(),
      );
    });

    it('sends no bound when both are omitted or blank', async () => {
      mockApi.listCrsReports.mockResolvedValue(structuredClone(page));
      const ctx = createMockContext({ errors: crsReportsTool.errors });
      await crsReportsTool.handler(
        crsReportsTool.input.parse({ operation: 'list', fromDateTime: '', toDateTime: '  ' }),
        ctx,
      );
      const params = mockApi.listCrsReports.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(params.fromDateTime).toBeUndefined();
      expect(params.toDateTime).toBeUndefined();
      expect(getEnrichment(ctx).effectiveQuery).toBe('CRS reports');
    });

    it.each([
      ['a date without a time', '2026-10-01'],
      ['an impossible date', '2026-02-30T00:00:00Z'],
      ['free text', 'last month'],
    ])('refuses %s on list and on get, before any request', async (_label, value) => {
      for (const input of [
        { operation: 'list', fromDateTime: value },
        { operation: 'get', reportNumber: 'R40097', toDateTime: value },
      ]) {
        const ctx = createMockContext({ errors: crsReportsTool.errors });
        await expect(
          crsReportsTool.handler(crsReportsTool.input.parse(input), ctx),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('ISO 8601'),
        });
      }
      expect(mockApi.listCrsReports).not.toHaveBeenCalled();
      expect(mockApi.getCrsReport).not.toHaveBeenCalled();
    });

    it('refuses a reversed window on get as on list, before any request', async () => {
      for (const operation of ['list', 'get']) {
        const ctx = createMockContext({ errors: crsReportsTool.errors });
        const input = crsReportsTool.input.parse({
          operation,
          reportNumber: operation === 'get' ? 'R40097' : undefined,
          fromDateTime: TO,
          toDateTime: FROM,
        });
        await expect(crsReportsTool.handler(input, ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { field: 'fromDateTime' },
        });
      }
      expect(mockApi.listCrsReports).not.toHaveBeenCalled();
      expect(mockApi.getCrsReport).not.toHaveBeenCalled();
    });

    it("serves 'get' with a valid window and names both ignored filters on both surfaces", async () => {
      mockApi.getCrsReport.mockResolvedValue({ report: { id: 'R40097', title: 'Climate' } });
      const result = await runToolContract(crsReportsTool, {
        operation: 'get',
        reportNumber: 'R40097',
        fromDateTime: FROM,
        toDateTime: TO,
      });
      expect(result.isError).not.toBe(true);
      expect(mockApi.getCrsReport).toHaveBeenCalledWith(
        { reportNumber: 'R40097' },
        expect.anything(),
      );
      const notice = "'get' does not use fromDateTime or toDateTime, so they were ignored.";
      expect(result.structuredContent).toMatchObject({ report: { id: 'R40097' }, notice });
      expect(contentText(result)).toContain(notice);
    });

    it('says a filtered list that matched nothing found no updates in the window', async () => {
      mockApi.listCrsReports.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });
      const ctx = createMockContext({ errors: crsReportsTool.errors });
      await crsReportsTool.handler(
        crsReportsTool.input.parse({
          operation: 'list',
          fromDateTime: '2025-03-01T00:00:00Z',
          toDateTime: '2025-03-31T23:59:59Z',
        }),
        ctx,
      );
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No CRS reports found');
      expect(notice).toContain('update date');
      expect(notice).not.toContain('temporarily unavailable');
    });

    it('leaves the notice unset when a filtered page is past the end of its results', async () => {
      mockApi.listCrsReports.mockResolvedValue({
        data: [],
        pagination: { count: 727, nextOffset: null },
      });
      const ctx = createMockContext({ errors: crsReportsTool.errors });
      await crsReportsTool.handler(
        crsReportsTool.input.parse({ operation: 'list', fromDateTime: FROM, offset: 750 }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
      expect(getEnrichment(ctx).totalCount).toBe(727);
    });
  });

  // ── #101: the report body through the HTML reading ──

  /**
   * The real document service reads the page; only the network is stubbed. The
   * page carries what an R46406-style CRS page does: a server-side `<script>`
   * naming REPORT_HTML_LOCATION, Highcharts chart scripts (one upper-case, one
   * closed by `</script >`, one inside a comment), a stylesheet, a table, and a list.
   */
  describe('content', () => {
    const HTML_URL = 'https://www.congress.gov/crs_external_products/R/HTML/R46406.html';
    const PDF_URL = 'https://www.congress.gov/crs_external_products/R/PDF/R46406/R46406.5.pdf';
    const PAGE = `<html><head><meta charset="utf-8"/><style>p { color: red; }</style></head>
<body><script language="C#" runat="server">public string REPORT_HTML_LOCATION = "x";</script>
<div class="Report"><div class="Title">Voter Registration</div>
<h1>Contents</h1>
<p class="BodyText">The NVRA &amp; <a href="#fn1">P.L. 103-31</a><sup>1</sup> applies.</p>
<script type="text/javascript">Highcharts.chart("c1", { title: "<p>x</p>" });</script>
<table><tr><td><p>Year</p></td><td><p>Voters</p></td></tr><tr><td>2020</td><td>158 million</td></tr></table>
<!-- <script>Highcharts.legacy()</script> -->
<ul><li>First</li><li>Second</li></ul>
<SCRIPT>Highcharts.setOptions({});</script >
</div></body></html>`;
    /** The page as the HTML reading lays it out: blocks as lines and paragraphs, table cells tab-joined. */
    const PAGE_TEXT =
      'Voter Registration\n\nContents\n\nThe NVRA & P.L. 103-311 applies.\n\nYear\tVoters\n2020\t158 million\n\nFirst\nSecond';

    const fetchMock = vi.fn<typeof fetch>();

    /** Serve PAGE at HTML_URL, as www.congress.gov does: text/html, no Content-Length. */
    function servePage(): void {
      fetchMock.mockImplementation(async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url !== HTML_URL) return new Response('', { status: 404 });
        const bytes = new TextEncoder().encode(PAGE);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 64) controller.enqueue(bytes.slice(i, i + 64));
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      });
    }

    /** A report record whose formats list PDF first and an HTML path that does not follow the ID. */
    function reportWith(formats: unknown): void {
      mockApi.getCrsReport.mockResolvedValue({ report: { id: 'R46406', formats } });
    }

    beforeEach(() => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockReset();
      initCongressDocuments();
      servePage();
      reportWith([
        { format: 'PDF', url: PDF_URL },
        { format: 'HTML', url: HTML_URL },
      ]);
    });

    afterEach(() => vi.unstubAllGlobals());

    it('reads the HTML version on both surfaces, with no script or style text', async () => {
      const result = await runToolContract(crsReportsTool, {
        operation: 'content',
        reportNumber: 'r46406',
      });
      expect(result.isError).not.toBe(true);
      expect(mockApi.getCrsReport).toHaveBeenCalledWith(
        { reportNumber: 'R46406' },
        expect.anything(),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(HTML_URL);
      expect(result.structuredContent).toEqual({
        content: {
          text: PAGE_TEXT,
          totalCharacters: PAGE_TEXT.length,
          offset: 0,
          truncated: false,
          nextOffset: null,
          format: 'html',
          sourceUrl: HTML_URL,
          documentTitle: 'CRS Report R46406',
        },
        effectiveQuery: `CRS report R46406, html characters 0–${PAGE_TEXT.length}`,
        totalCount: PAGE_TEXT.length,
      });

      const text = contentText(result);
      expect(text).toContain('# CRS Report R46406');
      expect(text).toContain('**Format:** html');
      expect(text).toContain(`**Source:** ${HTML_URL}`);
      expect(text).toContain(`\`\`\`\n${PAGE_TEXT}\n\`\`\``);
      for (const leaked of ['REPORT_HTML_LOCATION', 'Highcharts', 'color: red', '<p>']) {
        expect(text, leaked).not.toContain(leaked);
      }
    });

    it('walks nextOffset to null, returning every character once from one fetch', async () => {
      const chunks: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        if (chunks.length > 50) throw new Error('walk did not terminate');
        const result = await runToolContract(crsReportsTool, {
          operation: 'content',
          reportNumber: 'R46406',
          characterOffset: offset,
          characterLimit: 7,
        });
        const content = (result.structuredContent as { content: Record<string, unknown> }).content;
        expect(content.offset).toBe(offset);
        expect(content.totalCharacters).toBe(PAGE_TEXT.length);
        chunks.push(content.text as string);
        offset = content.nextOffset as number | null;
      }
      expect(chunks.length).toBe(Math.ceil(PAGE_TEXT.length / 7));
      expect(chunks.join('')).toBe(PAGE_TEXT);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('fails an offset at the end of the text as offset_past_end', async () => {
      const result = await runToolContract(crsReportsTool, {
        operation: 'content',
        reportNumber: 'R46406',
        characterOffset: PAGE_TEXT.length,
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'offset_past_end', totalCharacters: PAGE_TEXT.length },
        },
      });
    });

    it('fails a PDF-only report as format_unavailable naming its PDF URL, before any fetch', async () => {
      const pdf = 'https://www.congress.gov/crs_external_products/RL/PDF/RL30010/RL30010.3.pdf';
      reportWith([{ format: 'PDF', url: pdf }]);
      const result = await runToolContract(crsReportsTool, {
        operation: 'content',
        reportNumber: 'RL30010',
      });
      const hint = documentErrorContracts.find(
        (entry) => entry.reason === 'format_unavailable',
      )?.recovery;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: expect.stringContaining(`PDF at ${pdf}`),
          data: {
            reason: 'format_unavailable',
            formats: [{ format: 'PDF', url: pdf }],
            retryable: false,
            recovery: { hint },
          },
        },
      });
      expect(contentText(result)).toContain(pdf);
      expect(contentText(result)).toContain(`Recovery: ${hint}`);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['no formats array', undefined],
      ['an empty formats array', []],
      ['formats without a URL', [{ format: 'HTML' }, { format: 'PDF', url: ' ' }]],
    ])(
      'fails a report with %s as document_unavailable, before any fetch',
      async (_label, formats) => {
        reportWith(formats);
        const result = await runToolContract(crsReportsTool, {
          operation: 'content',
          reportNumber: 'R46406',
        });
        const hint = documentErrorContracts.find(
          (entry) => entry.reason === 'document_unavailable',
        )?.recovery;
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: { reason: 'document_unavailable', recovery: { hint } },
          },
        });
        expect(contentText(result)).toContain('publishes no document formats');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('fails a report whose HTML file Congress.gov does not hold as document_unavailable', async () => {
      reportWith([
        {
          format: 'HTML',
          url: 'https://www.congress.gov/crs_external_products/R/HTML/missing.html',
        },
      ]);
      const result = await runToolContract(crsReportsTool, {
        operation: 'content',
        reportNumber: 'R46406',
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'document_unavailable' } },
      });
    });

    it('serves the content and names the ignored date pair on both surfaces', async () => {
      const result = await runToolContract(crsReportsTool, {
        operation: 'content',
        reportNumber: 'R46406',
        fromDateTime: '2026-10-01T00:00:00Z',
        toDateTime: '2026-10-31T23:59:59Z',
      });
      const notice = "'content' does not use fromDateTime or toDateTime, so they were ignored.";
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ content: { text: PAGE_TEXT }, notice });
      expect(contentText(result)).toContain(notice);
    });

    it('requires reportNumber, before any request', async () => {
      const result = await runToolContract(crsReportsTool, { operation: 'content' });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining("'content' operation requires reportNumber"),
        },
      });
      expect(mockApi.getCrsReport).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("leaves 'list' and 'get' untouched by window fields", async () => {
      mockApi.listCrsReports.mockResolvedValue({
        data: [{ id: 'R46406', title: 'Voter Registration' }],
        pagination: { count: 1, nextOffset: null },
      });
      const list = await runToolContract(crsReportsTool, {
        operation: 'list',
        characterOffset: 10,
        characterLimit: 5,
      });
      expect(list.isError).not.toBe(true);
      expect(mockApi.listCrsReports).toHaveBeenCalledWith(
        { limit: 20, offset: 0 },
        expect.anything(),
      );
      expect(list.structuredContent).toMatchObject({ data: [{ id: 'R46406' }] });
      expect(list.structuredContent).not.toHaveProperty('notice');

      const get = await runToolContract(crsReportsTool, {
        operation: 'get',
        reportNumber: 'R46406',
        characterOffset: 10,
      });
      expect(get.structuredContent).toMatchObject({ report: { id: 'R46406' } });
      expect(get.structuredContent).not.toHaveProperty('content');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("names 'content' in the list identity refusal", async () => {
      const result = await runToolContract(crsReportsTool, {
        operation: 'list',
        reportNumber: 'R46406',
      });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'incompatible_identity', field: 'reportNumber' } },
      });
      expect(contentText(result)).toContain("'content'");
    });
  });

  // ── #110: 'get' pages the report's related materials ──

  /**
   * Congress.gov ignores limit/offset on /crsreport/{id} and returns every related
   * material (R46406: 168 rows, 163 once the service drops repeated URLs), so
   * 'get' pages the list itself with the tool's limit and offset.
   */
  describe('get pages relatedMaterials', () => {
    /** `count` distinct related materials, in upstream order. */
    const materials = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        congress: 117,
        number: String(i + 1),
        title: `Related material ${i + 1}`,
        type: 'PUB',
        url: `https://api.congress.gov/v3/law/117/pub/${i + 1}`,
      }));

    const serveReport = (id: string, rows: unknown[]) =>
      mockApi.getCrsReport.mockResolvedValue({
        report: { id, title: `Report ${id}`, summary: 'Summary text.', relatedMaterials: rows },
      });

    const get = (args: Record<string, unknown>) =>
      runToolContract(crsReportsTool, { operation: 'get', reportNumber: 'R46406', ...args });

    type Report = {
      relatedMaterials: Array<{ title: string }>;
      relatedMaterialsCount?: number;
      relatedMaterialsNextOffset?: number | null;
    };
    const reportOf = (result: Awaited<ReturnType<typeof get>>) =>
      (result.structuredContent as { report: Report }).report;

    it('returns a list that fits the first page unchanged, with no paging field and no notice', async () => {
      const rows = materials(19);
      serveReport('R47900', rows);
      const result = await get({ reportNumber: 'R47900' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        report: {
          id: 'R47900',
          title: 'Report R47900',
          summary: 'Summary text.',
          relatedMaterials: rows,
        },
        effectiveQuery: 'CRS report R47900',
        totalCount: 1,
      });
      const text = contentText(result);
      for (const row of rows) expect(text).toContain(row.title);
      expect(text).not.toContain('Related materials:');
    });

    it.each([
      { count: 20, limit: undefined },
      { count: 250, limit: 250 },
    ])(
      'returns a list exactly limit long ($count) as served, with no paging field and no notice',
      async ({ count, limit }) => {
        const rows = materials(count);
        serveReport('R47900', rows);
        const result = await get({ reportNumber: 'R47900', ...(limit ? { limit } : {}) });
        const report = reportOf(result);
        expect(report.relatedMaterials).toEqual(rows);
        expect(report).not.toHaveProperty('relatedMaterialsCount');
        expect(report).not.toHaveProperty('relatedMaterialsNextOffset');
        expect(result.structuredContent).not.toHaveProperty('notice');
        expect(contentText(result)).not.toContain('Related materials:');
      },
    );

    it('returns the first 20 of 163 with the count, next offset, and a notice, on both surfaces', async () => {
      const rows = materials(163);
      serveReport('R46406', rows);
      const result = await get({});
      const notice = 'Related materials 1–20 of 163 returned; pass offset 20 for the next page.';
      expect(result.structuredContent).toMatchObject({
        report: {
          id: 'R46406',
          summary: 'Summary text.',
          relatedMaterials: rows.slice(0, 20),
          relatedMaterialsCount: 163,
          relatedMaterialsNextOffset: 20,
        },
        notice,
        totalCount: 1,
      });
      expect(reportOf(result).relatedMaterials).toHaveLength(20);

      const text = contentText(result);
      expect(text).toContain('**Related materials:** 20 of 163 | next offset: 20');
      expect(text).toContain(notice);
      expect(text).toContain('Related material 20,');
      expect(text).not.toContain('Related material 21,');
    });

    it('walks nextOffset to null, returning each of 163 rows once, in order', async () => {
      const rows = materials(163);
      serveReport('R46406', rows);
      const seen: string[] = [];
      let offset: number | null = 0;
      let calls = 0;
      while (offset !== null) {
        if (++calls > 20) throw new Error('walk did not terminate');
        const result = await get({ offset });
        const report = reportOf(result);
        expect(report.relatedMaterialsCount).toBe(163);
        seen.push(...report.relatedMaterials.map((row) => row.title));
        offset = report.relatedMaterialsNextOffset ?? null;
        if (offset === null) {
          expect(report.relatedMaterialsNextOffset).toBeNull();
          expect(contentText(result)).toContain(
            '**Related materials:** 3 of 163 | next offset: none',
          );
          expect(contentText(result)).toContain(
            'Related materials 161–163 of 163 returned; this is the last page.',
          );
        }
      }
      expect(calls).toBe(9);
      expect(seen).toEqual(rows.map((row) => row.title));
    });

    it('returns all 229 at limit 250 with no added field', async () => {
      const rows = materials(229);
      serveReport('RL31693', rows);
      const result = await get({ reportNumber: 'RL31693', limit: 250 });
      expect(reportOf(result).relatedMaterials).toEqual(rows);
      expect(reportOf(result)).not.toHaveProperty('relatedMaterialsCount');
      expect(reportOf(result)).not.toHaveProperty('relatedMaterialsNextOffset');
      expect(result.structuredContent).not.toHaveProperty('notice');
    });

    it('pages a list one row longer than limit 250 at the cap', async () => {
      serveReport('R46406', materials(251));
      const report = reportOf(await get({ limit: 250 }));
      expect(report.relatedMaterials).toHaveLength(250);
      expect(report.relatedMaterialsCount).toBe(251);
      expect(report.relatedMaterialsNextOffset).toBe(250);
    });

    it('adds the paging fields when offset is past 0, even on a list that fits one page', async () => {
      const rows = materials(19);
      serveReport('R47900', rows);
      const result = await get({ reportNumber: 'R47900', offset: 5 });
      expect(reportOf(result)).toMatchObject({
        relatedMaterials: rows.slice(5),
        relatedMaterialsCount: 19,
        relatedMaterialsNextOffset: null,
      });
      expect(result.structuredContent).toMatchObject({
        notice: 'Related materials 6–19 of 19 returned; this is the last page.',
      });
    });

    it('returns no rows, the count, a null next offset, and a notice for an offset past the end', async () => {
      serveReport('R46406', materials(163));
      const result = await get({ offset: 200 });
      const notice =
        "offset 200 is past the end of this report's 163 related materials; restart at offset 0.";
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        report: {
          relatedMaterials: [],
          relatedMaterialsCount: 163,
          relatedMaterialsNextOffset: null,
        },
        notice,
      });
      const text = contentText(result);
      expect(text).toContain('**Related materials:** 0 of 163 | next offset: none');
      expect(text).toContain(notice);
    });

    it('leaves a report without relatedMaterials as served, whatever the offset', async () => {
      mockApi.getCrsReport.mockResolvedValue({ report: { id: 'R40097', title: 'Sparse' } });
      const result = await get({ reportNumber: 'R40097', offset: 40 });
      expect(result.structuredContent).toEqual({
        report: { id: 'R40097', title: 'Sparse' },
        effectiveQuery: 'CRS report R40097',
        totalCount: 1,
      });
    });

    it('composes its notice after the ignored-date notice', async () => {
      serveReport('R46406', materials(163));
      const result = await get({ fromDateTime: '2026-10-01T00:00:00Z' });
      expect(result.structuredContent).toMatchObject({
        notice:
          "'get' does not use fromDateTime, so it was ignored. Related materials 1–20 of 163 returned; pass offset 20 for the next page.",
      });
    });

    it("names 'get' in the limit and offset descriptions and declares the paging fields", () => {
      const properties = (
        z.toJSONSchema(crsReportsTool.input, { io: 'input' }) as {
          properties: Record<string, { description?: string }>;
        }
      ).properties;
      expect(properties.limit?.description).toContain("related materials on 'get'");
      expect(properties.offset?.description).toContain("related materials on 'get'");
      expect(crsReportsTool.description).toContain('relatedMaterialsNextOffset');

      const paged = { id: 'R46406', relatedMaterialsCount: 163, relatedMaterialsNextOffset: null };
      expect(crsReportsTool.output.parse({ report: paged })).toEqual({ report: paged });
      expect(() =>
        crsReportsTool.output.parse({ report: { id: 'R46406', relatedMaterialsCount: -1 } }),
      ).toThrow();
    });

    it('rejects a limit above 250 at the schema', () => {
      expect(
        crsReportsTool.input.safeParse({ operation: 'get', reportNumber: 'R46406', limit: 251 })
          .success,
      ).toBe(false);
    });

    it("leaves 'list' paging the reports and 'content' reading the document", async () => {
      mockApi.listCrsReports.mockResolvedValue({
        data: [{ id: 'R46406' }],
        pagination: { count: 900, nextOffset: 45 },
      });
      const list = await runToolContract(crsReportsTool, {
        operation: 'list',
        limit: 5,
        offset: 40,
      });
      expect(mockApi.listCrsReports).toHaveBeenCalledWith(
        { limit: 5, offset: 40 },
        expect.anything(),
      );
      expect(list.structuredContent).toMatchObject({
        data: [{ id: 'R46406' }],
        pagination: { count: 900, nextOffset: 45 },
      });
      expect(list.structuredContent).not.toHaveProperty('notice');
    });

    it('pages the list the service deduplicated, through the real service', async () => {
      const actual = await vi.importActual<
        typeof import('@/services/congress-api/congress-api-service.js')
      >('@/services/congress-api/congress-api-service.js');
      const unique = materials(163).map(({ url, ...row }) => ({ ...row, URL: url }));
      /** R46406's repeats: five rows whose URL an earlier row already carries. */
      const raw = [...unique.slice(0, 100), ...unique.slice(0, 5), ...unique.slice(100)];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            CRSReport: { id: 'R46406', title: 'Voter Registration', relatedMaterials: raw },
          }),
        ),
      );
      try {
        vi.mocked(getCongressApi).mockReturnValue(new actual.CongressApiService());
        const result = await get({ offset: 160 });
        expect(reportOf(result)).toMatchObject({
          relatedMaterials: materials(163).slice(160),
          relatedMaterialsCount: 163,
          relatedMaterialsNextOffset: null,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
