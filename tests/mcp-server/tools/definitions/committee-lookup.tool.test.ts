/**
 * @fileoverview Tests for congressgov_committee_lookup tool.
 * @module tests/mcp-server/tools/definitions/committee-lookup.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { committeeLookupTool } from '@/mcp-server/tools/definitions/committee-lookup.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('committeeLookupTool', () => {
  const mockApi = {
    listCommittees: vi.fn(),
    getCommittee: vi.fn(),
    getCommitteeSubResource: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists committees', async () => {
    const ctx = createMockContext();
    mockApi.listCommittees.mockResolvedValue({
      data: [{ name: 'Judiciary' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({ operation: 'list' });
    const result = await committeeLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('lists committees filtered by chamber and congress', async () => {
    const ctx = createMockContext();
    mockApi.listCommittees.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'list',
      congress: 118,
      chamber: 'senate',
    });
    await committeeLookupTool.handler(input, ctx);
    expect(mockApi.listCommittees).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, chamber: 'senate' }),
      ctx,
    );
  });

  it('gets a specific committee', async () => {
    const ctx = createMockContext();
    mockApi.getCommittee.mockResolvedValue({ committee: { name: 'Judiciary' } });
    const input = committeeLookupTool.input.parse({
      operation: 'get',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    const result = await committeeLookupTool.handler(input, ctx);
    expect(result.committee).toEqual({ name: 'Judiciary' });
    expect(mockApi.getCommittee).toHaveBeenCalledWith('house', 'hsju00', ctx);
  });

  it('throws when get is missing chamber or committeeCode', async () => {
    const ctx = createMockContext();
    const input = committeeLookupTool.input.parse({ operation: 'get' });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });

  it('throws when nominations requested for non-senate committee', async () => {
    const ctx = createMockContext();
    const input = committeeLookupTool.input.parse({
      operation: 'nominations',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    await expect(committeeLookupTool.handler(input, ctx)).rejects.toThrow(/Senate/);
  });

  it('fetches committee bills sub-resource', async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeSubResource.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    await committeeLookupTool.handler(input, ctx);
    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'bills' }),
      ctx,
    );
  });
});
