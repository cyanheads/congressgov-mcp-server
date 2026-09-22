/**
 * @fileoverview Tests for congressgov_bill_lookup tool.
 * @module tests/mcp-server/tools/definitions/bill-lookup.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import {
  DEFAULT_CONTENT_CHARACTERS,
  DEFAULT_SUMMARY_TEXT_CHARACTERS,
  SUMMARY_PAGE_CHARACTERS,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('billLookupTool', () => {
  const mockApi = {
    listBills: vi.fn(),
    getBill: vi.fn(),
    getBillSubResource: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists bills by congress', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.listBills.mockResolvedValue({
      data: [{ number: 1 }, { number: 2 }],
      pagination: { count: 2, nextOffset: null },
    });
    const input = billLookupTool.input.parse({ operation: 'list', congress: 118 });
    const result = await billLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(2);
    expect(mockApi.listBills).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, limit: 20, offset: 0 }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('bills');
    expect(enrichment.totalCount).toBe(2);
    expect(enrichment.notice).toBeUndefined();
  });

  it('lists bills filtered by type', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.listBills.mockResolvedValue({
      data: [{ number: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      billType: 'hr',
    });
    await billLookupTool.handler(input, ctx);
    expect(mockApi.listBills).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, billType: 'hr' }),
      ctx,
    );
  });

  it('gets a specific bill', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.getBill.mockResolvedValue({ bill: { title: 'Test Bill' } });
    const input = billLookupTool.input.parse({
      operation: 'get',
      congress: 118,
      billType: 'hr',
      billNumber: 1234,
    });
    const result = await billLookupTool.handler(input, ctx);
    expect(result.bill).toEqual({ title: 'Test Bill' });
    expect(mockApi.getBill).toHaveBeenCalledWith(
      {
        congress: 118,
        billType: 'hr',
        billNumber: 1234,
      },
      ctx,
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('HR 1234');
    expect(enrichment.totalCount).toBe(1);
  });

  // ── #43: list rows carry `number` as a string — drill-downs must accept it ──

  describe('numeric-string billNumber chaining', () => {
    it('accepts the string form a list row carries and normalizes it to a number', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBill.mockResolvedValue({ bill: { title: 'Test Bill' } });
      const input = billLookupTool.input.parse({
        operation: 'get',
        congress: 119,
        billType: 'hr',
        billNumber: '9479',
      });
      await billLookupTool.handler(input, ctx);
      expect(mockApi.getBill).toHaveBeenCalledWith(
        { congress: 119, billType: 'hr', billNumber: 9479 },
        ctx,
      );
      expect(getEnrichment(ctx).effectiveQuery).toContain('HR 9479');
    });

    it('accepts a zero-padded digit string', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBill.mockResolvedValue({ bill: { title: 'Test Bill' } });
      const input = billLookupTool.input.parse({
        operation: 'get',
        congress: 119,
        billType: 'hr',
        billNumber: '0009479',
      });
      await billLookupTool.handler(input, ctx);
      expect(mockApi.getBill).toHaveBeenCalledWith(
        expect.objectContaining({ billNumber: 9479 }),
        ctx,
      );
    });

    it('normalizes the string form on sub-resource operations too', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });
      const input = billLookupTool.input.parse({
        operation: 'actions',
        congress: 119,
        billType: 'hr',
        billNumber: '9479',
      });
      await billLookupTool.handler(input, ctx);
      expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
        expect.objectContaining({ billNumber: 9479, subResource: 'actions' }),
        ctx,
      );
    });

    it.each([
      ['non-numeric', 'abc'],
      ['digits with a trailing letter', '9479x'],
      ['letter-infixed digits', '12a'],
      ['decimal', '94.5'],
      ['negative', '-5'],
      ['explicitly signed', '+5'],
      ['zero', '0'],
      ['zero-padded zero', '000'],
      ['empty', ''],
      ['whitespace-only', '   '],
      ['padded digits', ' 9479 '],
      ['scientific notation', '1e3'],
      ['hexadecimal', '0x10'],
    ])('rejects a %s billNumber at schema parse time', (_label, value) => {
      expect(() =>
        billLookupTool.input.parse({
          operation: 'get',
          congress: 119,
          billType: 'hr',
          billNumber: value,
        }),
      ).toThrow();
    });

    it('still rejects a non-positive numeric billNumber', () => {
      expect(() =>
        billLookupTool.input.parse({
          operation: 'get',
          congress: 119,
          billType: 'hr',
          billNumber: 0,
        }),
      ).toThrow();
      expect(() =>
        billLookupTool.input.parse({
          operation: 'get',
          congress: 119,
          billType: 'hr',
          billNumber: 1.5,
        }),
      ).toThrow();
    });
  });

  // ── #47: the subjects page carries the policy area alongside the subjects ──

  describe('subjects operation', () => {
    const subjectsPage = {
      data: [
        {
          subjectType: 'policyArea',
          name: 'International Affairs',
          updateDate: '2026-08-11T13:47:33Z',
        },
        {
          subjectType: 'legislativeSubject',
          name: 'Income tax deductions',
          updateDate: '2026-04-28T13:58:38Z',
        },
      ],
      pagination: { count: 4, nextOffset: 2 },
    };

    it('carries the policy area on both output surfaces', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue(subjectsPage);
      const input = billLookupTool.input.parse({
        operation: 'subjects',
        congress: 119,
        billType: 'hr',
        billNumber: 5334,
        limit: 2,
      });
      const result = await billLookupTool.handler(input, ctx);

      expect(result.data?.[0]).toMatchObject({
        subjectType: 'policyArea',
        name: 'International Affairs',
      });

      const content = billLookupTool.format!(result)
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      expect(content).toContain('International Affairs');
      expect(content).toContain('policyArea');
      expect(content).toContain('Income tax deductions');
      expect(content).toContain('next offset: 2');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(4);
      expect(enrichment.effectiveQuery).toContain('subjects for HR 5334');
      expect(enrichment.notice).toBeUndefined();
    });

    it('notices a bill with no subjects at all', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });
      const input = billLookupTool.input.parse({
        operation: 'subjects',
        congress: 119,
        billType: 'hr',
        billNumber: 5334,
      });
      const result = await billLookupTool.handler(input, ctx);

      expect(result.data).toHaveLength(0);
      expect(getEnrichment(ctx).notice).toMatch(/No subjects found for HR 5334/);
    });
  });

  it('throws when get is missing billType or billNumber', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    const input = billLookupTool.input.parse({ operation: 'get', congress: 118 });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  it('fetches bill sub-resources', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.getBillSubResource.mockResolvedValue({
      data: [{ action: 'Introduced' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = billLookupTool.input.parse({
      operation: 'actions',
      congress: 118,
      billType: 'hr',
      billNumber: 1234,
    });
    const result = await billLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'actions' }),
      ctx,
    );
  });

  it('maps related operation to relatedbills sub-resource', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.getBillSubResource.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = billLookupTool.input.parse({
      operation: 'related',
      congress: 118,
      billType: 's',
      billNumber: 1,
    });
    await billLookupTool.handler(input, ctx);
    expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'relatedbills' }),
      ctx,
    );
  });

  it('ignores empty-string date filters from form-based clients', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.listBills.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = billLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      fromDateTime: '',
      toDateTime: '',
    });
    await billLookupTool.handler(input, ctx);
    const [paramsArg, passedCtx] = mockApi.listBills.mock.calls[0]!;
    expect(paramsArg.fromDateTime).toBeUndefined();
    expect(paramsArg.toDateTime).toBeUndefined();
    expect(passedCtx).toBe(ctx);
  });

  it('applies default limit and offset', () => {
    const input = billLookupTool.input.parse({ operation: 'list', congress: 118 });
    expect(input.limit).toBe(20);
    expect(input.offset).toBe(0);
  });

  it('populates notice when list returns empty results', async () => {
    const ctx = createMockContext({ errors: billLookupTool.errors });
    mockApi.listBills.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = billLookupTool.input.parse({ operation: 'list', congress: 118, billType: 'hr' });
    await billLookupTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toMatch(/No bills/);
  });

  // ── #70: version selection and character windowing on `summaries` ──

  describe('summaries operation', () => {
    /** `text` is exactly `textCharacters` long, wrapper included. */
    const summaryRow = (versionCode: string, actionDesc: string, textCharacters: number) => ({
      actionDate: '2024-03-09',
      actionDesc,
      updateDate: '2024-03-23T05:43:39Z',
      versionCode,
      text: `<p>${versionCode.padEnd(textCharacters - 7, 'z')}</p>`,
    });

    const joinText = (blocks: Array<{ type: string; text?: string }>) =>
      blocks.map((block) => block.text ?? '').join('\n');

    const summariesInput = (extra: Record<string, unknown> = {}) =>
      billLookupTool.input.parse({
        operation: 'summaries',
        congress: 118,
        billType: 'hr',
        billNumber: 2882,
        ...extra,
      });

    it('leaves a page inside both limits byte-identical on each surface', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      const upstream = {
        data: [summaryRow('00', 'Introduced in House', 800)],
        pagination: { count: 1, nextOffset: null },
      };
      const before = JSON.stringify(upstream);
      const beforeContent = joinText(billLookupTool.format!(structuredClone(upstream)));
      mockApi.getBillSubResource.mockResolvedValue(structuredClone(upstream));

      const result = await billLookupTool.handler(summariesInput(), ctx);

      expect(JSON.stringify(billLookupTool.output.parse(result))).toBe(before);
      expect(joinText(billLookupTool.format!(result))).toBe(beforeContent);
      expect(getEnrichment(ctx).notice).toBeUndefined();
      expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
        expect.objectContaining({ subResource: 'summaries', limit: 20, offset: 0 }),
        ctx,
      );
    });

    it("selects one version over the bill's whole summary list", async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [
          summaryRow('00', 'Introduced in House', 400),
          summaryRow('49', 'Public Law', 900),
          summaryRow('53', 'Passed House', 500),
        ],
        pagination: { count: 3, nextOffset: null },
      });

      const result = await billLookupTool.handler(summariesInput({ versionCode: '49' }), ctx);

      expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
        expect.objectContaining({ subResource: 'summaries', limit: 250, offset: 0 }),
        ctx,
      );
      expect(result.data).toHaveLength(1);
      expect(result.data?.[0]).toMatchObject({ versionCode: '49', actionDesc: 'Public Law' });
      expect(result.pagination).toEqual({ count: 1, nextOffset: null });
      expect(getEnrichment(ctx).effectiveQuery).toContain('versionCode=49');
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('treats an empty-string versionCode from a form client as omitted', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [summaryRow('00', 'Introduced in House', 400)],
        pagination: { count: 1, nextOffset: null },
      });

      await billLookupTool.handler(summariesInput({ versionCode: '' }), ctx);

      expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20, offset: 0 }),
        ctx,
      );
    });

    it('returns an empty page and names the versions published when none match', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [summaryRow('00', 'Introduced in House', 400), summaryRow('49', 'Public Law', 400)],
        pagination: { count: 2, nextOffset: null },
      });

      const result = await billLookupTool.handler(summariesInput({ versionCode: '99' }), ctx);

      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({ count: 0, nextOffset: null });
      expect(getEnrichment(ctx).notice).toBe(
        "No summary with versionCode '99' for HR 2882. Versions published: 00, 49.",
      );
    });

    it('says so when the bill publishes no summaries at all', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [],
        pagination: { count: 0, nextOffset: null },
      });

      await billLookupTool.handler(summariesInput({ versionCode: '49' }), ctx);

      expect(getEnrichment(ctx).notice).toBe(
        "No summary with versionCode '49' for HR 2882. Congress.gov publishes no summaries for this bill.",
      );
    });

    it('pages the matching rows with limit and offset', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [
          summaryRow('49', 'Public Law', 400),
          summaryRow('00', 'Introduced in House', 400),
          summaryRow('49', 'Public Law (revised)', 400),
        ],
        pagination: { count: 3, nextOffset: null },
      });

      const first = await billLookupTool.handler(
        summariesInput({ versionCode: '49', limit: 1 }),
        ctx,
      );
      expect(first.data).toHaveLength(1);
      expect(first.pagination).toEqual({ count: 2, nextOffset: 1 });

      const second = await billLookupTool.handler(
        summariesInput({ versionCode: '49', limit: 1, offset: 1 }),
        createMockContext({ errors: billLookupTool.errors }),
      );
      expect(second.data?.[0]).toMatchObject({ actionDesc: 'Public Law (revised)' });
      expect(second.pagination).toEqual({ count: 2, nextOffset: null });
    });

    it('does not claim the version is missing when the offset ran past its rows', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [summaryRow('00', 'Introduced in House', 400), summaryRow('49', 'Public Law', 400)],
        pagination: { count: 2, nextOffset: null },
      });

      const result = await billLookupTool.handler(
        summariesInput({ versionCode: '49', offset: 5 }),
        ctx,
      );

      expect(result.data).toEqual([]);
      expect(result.pagination).toEqual({ count: 1, nextOffset: null });
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('walks a long summary to the end and reassembles it exactly', async () => {
      const source = summaryRow('49', 'Public Law', 4_000);
      const windows: string[] = [];
      let characterOffset: number | null = 0;
      let total: number | undefined;

      for (let guard = 0; characterOffset !== null; guard++) {
        expect(guard).toBeLessThan(50);
        mockApi.getBillSubResource.mockResolvedValue({
          data: [structuredClone(source)],
          pagination: { count: 1, nextOffset: null },
        });
        const result = await billLookupTool.handler(
          summariesInput({ versionCode: '49', characterOffset, characterLimit: 700 }),
          createMockContext({ errors: billLookupTool.errors }),
        );
        const row = result.data?.[0] as Record<string, unknown>;
        windows.push(row.text as string);
        total = row.textTotalCharacters as number;
        const next = row.textNextOffset;
        characterOffset = typeof next === 'number' ? next : null;
      }

      expect(total).toBe(4_000);
      expect(windows.join('')).toBe(source.text);
      expect(windows.length).toBeGreaterThan(5);
      expect(windows.every((window) => window.length > 0 && window.length <= 700)).toBe(true);
    });

    it('fails with offset_past_end when every row is exhausted', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [summaryRow('49', 'Public Law', 400)],
        pagination: { count: 1, nextOffset: null },
      });

      await expect(
        billLookupTool.handler(summariesInput({ versionCode: '49', characterOffset: 400 }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: {
          reason: 'offset_past_end',
          characterOffset: 400,
          recovery: { hint: expect.stringContaining('textNextOffset') },
        },
      });
    });

    it('still returns the rows that have text left at that offset', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [summaryRow('00', 'Introduced in House', 300), summaryRow('49', 'Public Law', 900)],
        pagination: { count: 2, nextOffset: null },
      });

      const result = await billLookupTool.handler(summariesInput({ characterOffset: 400 }), ctx);

      const rows = result.data as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({ text: '', textTotalCharacters: 300 });
      expect(rows[1]?.text).toHaveLength(500);
      const content = joinText(billLookupTool.format!(result));
      expect(content).toContain("0 of 300 characters — characterOffset is past this summary's end");
    });

    it('stops a multi-version page at the page budget', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: Array.from({ length: 12 }, (_, index) =>
          summaryRow(String(index).padStart(2, '0'), `Version ${index}`, 6_000),
        ),
        pagination: { count: 12, nextOffset: null },
      });

      const result = await billLookupTool.handler(summariesInput({ limit: 12 }), ctx);

      expect(result.data!.length).toBeLessThan(12);
      expect(result.pagination?.nextOffset).toBe(result.data!.length);
      expect(
        result.data!.reduce((sum, row) => sum + JSON.stringify(row).length, 0),
      ).toBeLessThanOrEqual(SUMMARY_PAGE_CHARACTERS);
      expect(getEnrichment(ctx).notice).toContain('50,000-character budget');
    });

    it('carries the window fields through the declared output schema and content[]', async () => {
      mockApi.getBillSubResource.mockResolvedValue({
        data: [summaryRow('49', 'Public Law', DEFAULT_SUMMARY_TEXT_CHARACTERS + 3_000)],
        pagination: { count: 1, nextOffset: null },
      });

      const result = await runToolContract(billLookupTool, {
        operation: 'summaries',
        congress: 118,
        billType: 'hr',
        billNumber: 2882,
        versionCode: '49',
      });

      expect(result.isError).toBeFalsy();
      const structured = billLookupTool.output.parse(result.structuredContent) as {
        data?: Array<Record<string, unknown>>;
      };
      expect(structured.data?.[0]).toMatchObject({
        textTotalCharacters: DEFAULT_SUMMARY_TEXT_CHARACTERS + 3_000,
        textTruncated: true,
        textNextOffset: DEFAULT_SUMMARY_TEXT_CHARACTERS,
      });

      const content = joinText(result.content as Array<{ type: string; text?: string }>);
      expect(content).toContain('**Summary text:** characters 1–25,000 of 28,000');
      expect(content).toContain('**Truncated:** true');
      expect(content).toContain('next characterOffset: 25000');
    });

    it('names a continuation call its own schema accepts verbatim', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [summaryRow('49', 'Public Law', DEFAULT_SUMMARY_TEXT_CHARACTERS + 3_000)],
        pagination: { count: 1, nextOffset: null },
      });

      await billLookupTool.handler(summariesInput({ versionCode: '49' }), ctx);
      const notice = getEnrichment(ctx).notice as string;

      expect(notice).toContain(
        'Continue with: congressgov_bill_lookup {"operation":"summaries","congress":118,"billType":"hr","billNumber":"2882","versionCode":"49","characterOffset":25000}',
      );
      const args = notice.slice(notice.indexOf('{', notice.indexOf('congressgov_bill_lookup ')));
      expect(
        billLookupTool.input.parse(JSON.parse(args.slice(0, args.indexOf('}') + 1))),
      ).toMatchObject({
        operation: 'summaries',
        billType: 'hr',
        billNumber: '2882',
        characterOffset: 25_000,
      });
    });

    it('ignores versionCode on the other sub-resource operations', async () => {
      const ctx = createMockContext({ errors: billLookupTool.errors });
      mockApi.getBillSubResource.mockResolvedValue({
        data: [{ actionDate: '2024-01-01', text: 'Introduced.' }],
        pagination: { count: 1, nextOffset: null },
      });

      await billLookupTool.handler(
        billLookupTool.input.parse({
          operation: 'actions',
          congress: 118,
          billType: 'hr',
          billNumber: 2882,
          versionCode: '49',
        }),
        ctx,
      );

      expect(mockApi.getBillSubResource).toHaveBeenCalledWith(
        expect.objectContaining({ subResource: 'actions', limit: 20, offset: 0 }),
        ctx,
      );
    });
  });

  describe('document window inputs', () => {
    it('keeps the shared defaults after the summaries-aware descriptions', () => {
      const input = billLookupTool.input.parse({ operation: 'list', congress: 118 });
      expect(input.characterOffset).toBe(0);
      expect(input.characterLimit).toBe(DEFAULT_CONTENT_CHARACTERS);
    });

    it('describes both operations that read the window', () => {
      const shape = billLookupTool.input.shape;
      expect(shape.characterOffset.description).toContain("'summaries'");
      expect(shape.characterOffset.description).toContain("'content'");
      expect(shape.characterLimit.description).toContain("'summaries'");
      expect(shape.characterLimit.description).toContain('100000');
    });
  });
});
