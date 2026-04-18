/**
 * @fileoverview Tests for congressgov_bill_summaries tool.
 * @module tests/mcp-server/tools/definitions/bill-summaries.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billSummariesTool } from '@/mcp-server/tools/definitions/bill-summaries.tool.js';
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = billSummariesTool.input.parse({ billType: 'hr' });
    await expect(billSummariesTool.handler(input, ctx)).rejects.toThrow(/congress/);
  });

  it('treats empty-string dates from form-based clients as omitted', async () => {
    const ctx = createMockContext();
    mockApi.listSummaries.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = billSummariesTool.input.parse({
      fromDateTime: '',
      toDateTime: '',
    });
    await billSummariesTool.handler(input, ctx);
    const [paramsArg, passedCtx] = mockApi.listSummaries.mock.calls[0];
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
});
