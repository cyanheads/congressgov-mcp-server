/**
 * @fileoverview Tests for congressgov_bill_lookup tool.
 * @module tests/mcp-server/tools/definitions/bill-lookup.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext();
    mockApi.listBills.mockResolvedValue({
      data: [{ number: 1 }, { number: 2 }],
      pagination: { count: 2, nextOffset: null },
    });
    const input = billLookupTool.input.parse({ operation: 'list', congress: 118 });
    const result = await billLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(2);
    expect(mockApi.listBills).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, limit: 20, offset: 0 }),
    );
  });

  it('lists bills filtered by type', async () => {
    const ctx = createMockContext();
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
    );
  });

  it('gets a specific bill', async () => {
    const ctx = createMockContext();
    mockApi.getBill.mockResolvedValue({ bill: { title: 'Test Bill' } });
    const input = billLookupTool.input.parse({
      operation: 'get',
      congress: 118,
      billType: 'hr',
      billNumber: 1234,
    });
    const result = await billLookupTool.handler(input, ctx);
    expect(result.bill).toEqual({ title: 'Test Bill' });
    expect(mockApi.getBill).toHaveBeenCalledWith({
      congress: 118,
      billType: 'hr',
      billNumber: 1234,
    });
  });

  it('throws when get is missing billType or billNumber', async () => {
    const ctx = createMockContext();
    const input = billLookupTool.input.parse({ operation: 'get', congress: 118 });
    await expect(billLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  it('fetches bill sub-resources', async () => {
    const ctx = createMockContext();
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
    );
  });

  it('maps related operation to relatedbills sub-resource', async () => {
    const ctx = createMockContext();
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
    );
  });

  it('applies default limit and offset', () => {
    const input = billLookupTool.input.parse({ operation: 'list', congress: 118 });
    expect(input.limit).toBe(20);
    expect(input.offset).toBe(0);
  });
});
