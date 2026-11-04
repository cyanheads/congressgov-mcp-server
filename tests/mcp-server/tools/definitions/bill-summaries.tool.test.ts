/**
 * @fileoverview Tests for congressgov_bill_summaries tool.
 * @module tests/mcp-server/tools/definitions/bill-summaries.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { billSummariesTool } from '@/mcp-server/tools/definitions/bill-summaries.tool.js';
import { DEFAULT_SUMMARY_TEXT_CHARACTERS } from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('billSummariesTool', () => {
  const mockApi = {
    listSummaries: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists recent summaries with default 7-day window', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    mockApi.listSummaries.mockResolvedValue({
      data: [{ text: 'Summary' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = billSummariesTool.input.parse({});
    const result = await billSummariesTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect(mockApi.listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        fromDateTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
      ctx,
    );
  });

  it('passes explicit date range', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = billSummariesTool.input.parse({
      fromDateTime: '2024-01-01T00:00:00Z',
      toDateTime: '2024-01-31T23:59:59Z',
    });
    await billSummariesTool.handler(input, ctx);
    expect(mockApi.listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        fromDateTime: '2024-01-01T00:00:00Z',
        toDateTime: '2024-01-31T23:59:59Z',
      }),
      ctx,
    );
  });

  it('filters by congress and bill type', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = billSummariesTool.input.parse({
      congress: 118,
      billType: 'hr',
    });
    await billSummariesTool.handler(input, ctx);
    expect(mockApi.listSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, billType: 'hr' }),
      ctx,
    );
  });

  it('throws when billType is provided without congress', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    const input = billSummariesTool.input.parse({ billType: 'hr' });
    await expect(billSummariesTool.handler(input, ctx)).rejects.toThrow(/congress/);
  });

  it('treats empty-string dates from form-based clients as omitted', async () => {
    const ctx = createMockContext({ errors: billSummariesTool.errors });
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = billSummariesTool.input.parse({
      fromDateTime: '',
      toDateTime: '',
    });
    await billSummariesTool.handler(input, ctx);
    const [paramsArg, passedCtx] = mockApi.listSummaries.mock.calls[0]!;
    expect(paramsArg.fromDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(paramsArg.toDateTime).toBeUndefined();
    expect(passedCtx).toBe(ctx);
  });

  it('formats sparse upstream summaries without inventing missing facts', () => {
    const output = billSummariesTool.output.parse({
      data: [{ bill: { congress: 118, type: 'hr', number: '1' } }],
      pagination: { count: 1, nextOffset: null },
    });
    const blocks = billSummariesTool.format!(output);
    expect((blocks[0] as { text: string }).text).toContain('Bill Title:** Not available');
    expect((blocks[0] as { text: string }).text).toContain('Summary text not available');
  });

  // ── #70: one row's summary text arrives a window at a time; #98: limit alone bounds the page ──

  describe('response bounding', () => {
    const summaryRow = (index: number, textCharacters: number) => ({
      actionDate: '2026-08-04',
      actionDesc: 'Introduced in House',
      versionCode: '00',
      updateDate: '2026-08-05T00:00:00Z',
      lastSummaryUpdateDate: '2026-08-05T00:00:00Z',
      /** `text` is exactly `textCharacters` long, wrapper included. */
      text: `<p>${String(index).padEnd(textCharacters - 7, 'z')}</p>`,
      bill: {
        congress: 119,
        type: 'HR',
        number: String(1000 + index),
        title: `Sample Act ${index}`,
        url: `https://api.congress.gov/v3/bill/119/hr/${1000 + index}?format=json`,
      },
    });

    const joinText = (blocks: Array<{ type: string; text?: string }>) =>
      blocks.map((block) => block.text ?? '').join('\n');

    /** The bill_lookup call a notice prints, parsed back through its own schema. */
    const continuationFromNotice = (notice: string) => {
      const call = notice.slice(notice.indexOf('congressgov_bill_lookup '));
      const args = call.slice(call.indexOf('{'), call.lastIndexOf('}') + 1);
      return billLookupTool.input.parse(JSON.parse(args));
    };

    it('leaves a page inside the budget byte-identical on both surfaces', async () => {
      const ctx = createMockContext({ errors: billSummariesTool.errors });
      const upstream = {
        data: [summaryRow(0, 900), summaryRow(1, 1_200)],
        pagination: { count: 40, nextOffset: 2 },
      };
      const before = JSON.stringify(upstream);
      const beforeContent = joinText(billSummariesTool.format!(structuredClone(upstream)));
      mockApi.listSummaries.mockResolvedValue(structuredClone(upstream));

      const result = await billSummariesTool.handler(billSummariesTool.input.parse({}), ctx);

      expect(JSON.stringify(billSummariesTool.output.parse(result))).toBe(before);
      expect(joinText(billSummariesTool.format!(result))).toBe(beforeContent);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    /**
     * A mid-sized page — four rows serializing to about 44,000 characters, one
     * of them past the row window — exactly as the server has always returned
     * it: every row, upstream pagination, and only the row-window notice.
     */
    it('returns a mid-sized page with a windowed row exactly as before', async () => {
      const ctx = createMockContext({ errors: billSummariesTool.errors });
      const first = summaryRow(0, 6_000);
      const second = summaryRow(1, 6_000);
      const long = summaryRow(2, DEFAULT_SUMMARY_TEXT_CHARACTERS + 1_000);
      const last = summaryRow(3, 6_000);
      const upstream = {
        data: [first, second, long, last],
        pagination: { count: 40, nextOffset: 4 },
      };
      const expected = {
        data: [
          first,
          second,
          {
            ...long,
            text: long.text.slice(0, DEFAULT_SUMMARY_TEXT_CHARACTERS),
            textTotalCharacters: DEFAULT_SUMMARY_TEXT_CHARACTERS + 1_000,
            textTruncated: true,
            textNextOffset: DEFAULT_SUMMARY_TEXT_CHARACTERS,
          },
          last,
        ],
        pagination: { count: 40, nextOffset: 4 },
      };
      mockApi.listSummaries.mockResolvedValue(structuredClone(upstream));

      const result = await billSummariesTool.handler(
        billSummariesTool.input.parse({ limit: 4 }),
        ctx,
      );

      expect(JSON.stringify(billSummariesTool.output.parse(result))).toBe(JSON.stringify(expected));
      const content = joinText(billSummariesTool.format!(result));
      expect(content.match(/\*\*Summary text:\*\*/g)).toHaveLength(1);
      expect(content).toContain('**Summary text:** characters 1–25,000 of 26,000');
      expect(content).toContain('next characterOffset: 25000');
      for (const index of [0, 1, 2, 3]) expect(content).toContain(`Sample Act ${index}`);
      expect(getEnrichment(ctx).notice).toBe(
        `Summary text on row 3 runs 26,000 characters; characters 1–25,000 returned. Continue with: congressgov_bill_lookup {"operation":"summaries","congress":119,"billType":"hr","billNumber":"1002","versionCode":"00","characterOffset":25000}`,
      );
    });

    /** #98: `limit` is the only page boundary — no response-size stop. */
    it('returns every row asked for, whatever the page serializes to', async () => {
      const upstream = {
        data: Array.from({ length: 30 }, (_, index) => summaryRow(index, 6_000)),
        pagination: { count: 500, nextOffset: 60 },
      };
      mockApi.listSummaries.mockResolvedValue(structuredClone(upstream));

      const result = await runToolContract(billSummariesTool, { limit: 30, offset: 30 });

      expect(result.isError).toBeFalsy();
      const structured = billSummariesTool.output.parse(result.structuredContent);
      expect(JSON.stringify(structured.data).length).toBeGreaterThan(150_000);
      expect(structured.data).toEqual(upstream.data);
      expect(structured.pagination).toEqual({ count: 500, nextOffset: 60 });
      expect(result.structuredContent).not.toHaveProperty('notice');
      const content = joinText(result.content as Array<{ type: string; text?: string }>);
      expect(content).toContain('Sample Act 0');
      expect(content).toContain('Sample Act 29');
      expect(content).not.toMatch(/budget|rows requested/);
    });

    it('returns every oversized row, each one windowed', async () => {
      const ctx = createMockContext({ errors: billSummariesTool.errors });
      mockApi.listSummaries.mockResolvedValue({
        data: [
          summaryRow(0, DEFAULT_SUMMARY_TEXT_CHARACTERS + 5_000),
          summaryRow(1, DEFAULT_SUMMARY_TEXT_CHARACTERS + 5_000),
        ],
        pagination: { count: 2, nextOffset: null },
      });

      const result = await billSummariesTool.handler(billSummariesTool.input.parse({}), ctx);

      expect(result.data).toHaveLength(2);
      expect(result.pagination).toEqual({ count: 2, nextOffset: null });
      for (const row of result.data) {
        expect(row).toMatchObject({
          textTotalCharacters: DEFAULT_SUMMARY_TEXT_CHARACTERS + 5_000,
          textTruncated: true,
          textNextOffset: DEFAULT_SUMMARY_TEXT_CHARACTERS,
        });
      }
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toMatch(/^Summary text on row 1 runs 30,000 characters; /);
      expect(notice).toContain('2 rows on this page carry windowed text');
      expect(notice).not.toMatch(/budget|rows requested/);
    });

    it('describes no response-size stop', () => {
      expect(billSummariesTool.description).not.toMatch(/budget|stops adding rows/);
      expect(billSummariesTool.description).toContain('textNextOffset');
    });

    it('carries the window fields through the declared output schema and content[]', async () => {
      mockApi.listSummaries.mockResolvedValue({
        data: [summaryRow(0, DEFAULT_SUMMARY_TEXT_CHARACTERS + 4_000)],
        pagination: { count: 1, nextOffset: null },
      });

      const result = await runToolContract(billSummariesTool, {});

      expect(result.isError).toBeFalsy();
      const structured = billSummariesTool.output.parse(result.structuredContent) as {
        data: Array<Record<string, unknown>>;
      };
      expect(structured.data[0]).toMatchObject({
        textTotalCharacters: DEFAULT_SUMMARY_TEXT_CHARACTERS + 4_000,
        textTruncated: true,
        textNextOffset: expect.any(Number),
      });
      expect((structured.data[0]!.text as string).length).toBeLessThanOrEqual(
        DEFAULT_SUMMARY_TEXT_CHARACTERS,
      );

      const content = joinText(result.content as Array<{ type: string; text?: string }>);
      expect(content).toContain('**Summary text:** characters 1–');
      expect(content).toContain('**Truncated:** true');
      expect(content).toContain('next characterOffset:');
    });

    it('names a continuation call congressgov_bill_lookup accepts verbatim', async () => {
      const ctx = createMockContext({ errors: billSummariesTool.errors });
      mockApi.listSummaries.mockResolvedValue({
        data: [summaryRow(7, DEFAULT_SUMMARY_TEXT_CHARACTERS + 2_000)],
        pagination: { count: 1, nextOffset: null },
      });

      const result = await billSummariesTool.handler(billSummariesTool.input.parse({}), ctx);
      const notice = getEnrichment(ctx).notice as string;

      expect(notice).toContain('Continue with: congressgov_bill_lookup ');
      /** The row carries the upstream casing; the printed call carries the code. */
      expect(result.data[0]).toMatchObject({ bill: expect.objectContaining({ type: 'HR' }) });
      expect(continuationFromNotice(notice)).toMatchObject({
        operation: 'summaries',
        congress: 119,
        billType: 'hr',
        billNumber: '1007',
        versionCode: '00',
        characterOffset: result.data[0]!.textNextOffset,
      });
    });

    it('skips the continuation when a row carries no bill reference', async () => {
      const ctx = createMockContext({ errors: billSummariesTool.errors });
      const { bill: _bill, ...orphan } = summaryRow(0, DEFAULT_SUMMARY_TEXT_CHARACTERS + 100);
      mockApi.listSummaries.mockResolvedValue({
        data: [orphan],
        pagination: { count: 1, nextOffset: null },
      });

      await billSummariesTool.handler(billSummariesTool.input.parse({}), ctx);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('characters 1–');
      expect(notice).not.toContain('Continue with:');
    });
  });
});
