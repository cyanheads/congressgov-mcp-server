/**
 * @fileoverview Tests for congressgov_bill_lookup tool.
 * @module tests/mcp-server/tools/definitions/bill-lookup.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
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
});
