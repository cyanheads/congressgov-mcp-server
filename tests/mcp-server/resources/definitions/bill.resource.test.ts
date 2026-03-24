/**
 * @fileoverview Tests for congress://bill/{congress}/{billType}/{billNumber} resource.
 * @module tests/mcp-server/resources/definitions/bill.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { billResource } from '@/mcp-server/resources/definitions/bill.resource.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('billResource', () => {
  const mockApi = {
    getBill: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('returns bill detail for valid params', async () => {
    const ctx = createMockContext();
    const billData = { title: 'Test Act', sponsor: 'Smith' };
    mockApi.getBill.mockResolvedValue({ bill: billData });
    const params = billResource.params!.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '3076',
    });
    const result = await billResource.handler(params, ctx);
    expect(result).toEqual(billData);
    expect(mockApi.getBill).toHaveBeenCalledWith({
      congress: 118,
      billType: 'hr',
      billNumber: 3076,
    });
  });

  it('converts string params to numbers for API call', async () => {
    const ctx = createMockContext();
    mockApi.getBill.mockResolvedValue({ bill: {} });
    const params = billResource.params!.parse({
      congress: '119',
      billType: 's',
      billNumber: '1',
    });
    await billResource.handler(params, ctx);
    expect(mockApi.getBill).toHaveBeenCalledWith({
      congress: 119,
      billType: 's',
      billNumber: 1,
    });
  });
});
