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

  it("fetches committee bills sub-resource (order='oldest' passes through in one call)", async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeSubResource.mockResolvedValue({
      data: [{ number: '1' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      order: 'oldest',
    });
    await committeeLookupTool.handler(input, ctx);
    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(1);
    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'bills', limit: 20, offset: 0 }),
      ctx,
    );
  });

  it("order='recent' probes count then fetches tail and reverses", async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeSubResource
      .mockResolvedValueOnce({
        data: [{ number: 'first' }],
        pagination: { count: 100, nextOffset: 1 },
      })
      .mockResolvedValueOnce({
        data: [{ number: 'old' }, { number: 'mid' }, { number: 'new' }],
        pagination: { count: 100, nextOffset: null },
      });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      limit: 3,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(2);
    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ subResource: 'bills', limit: 1, offset: 0 }),
      ctx,
    );
    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ subResource: 'bills', limit: 3, offset: 97 }),
      ctx,
    );
    expect(result.data).toEqual([{ number: 'new' }, { number: 'mid' }, { number: 'old' }]);
    expect(result.pagination).toEqual({ count: 100, nextOffset: 3 });
  });

  it("order='recent' paginates backwards — offset=3 returns the next-older page", async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeSubResource
      .mockResolvedValueOnce({
        data: [{ number: 'first' }],
        pagination: { count: 100, nextOffset: 1 },
      })
      .mockResolvedValueOnce({
        data: [{ number: 'a' }, { number: 'b' }, { number: 'c' }],
        pagination: { count: 100, nextOffset: null },
      });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      limit: 3,
      offset: 3,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 3, offset: 94 }),
      ctx,
    );
    expect(result.pagination).toEqual({ count: 100, nextOffset: 6 });
  });

  it("order='recent' clamps to available items near the beginning of history", async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeSubResource
      .mockResolvedValueOnce({
        data: [{ number: 'first' }],
        pagination: { count: 5, nextOffset: 1 },
      })
      .mockResolvedValueOnce({
        data: [{ number: '1' }, { number: '2' }, { number: '3' }, { number: '4' }, { number: '5' }],
        pagination: { count: 5, nextOffset: null },
      });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      limit: 20,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 5, offset: 0 }),
      ctx,
    );
    expect(result.data).toHaveLength(5);
    expect(result.pagination).toEqual({ count: 5, nextOffset: null });
  });

  it("order='recent' returns empty when count is zero without a second fetch", async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeSubResource.mockResolvedValueOnce({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ count: 0, nextOffset: null });
  });

  it("order='recent' returns empty when offset runs past the end", async () => {
    const ctx = createMockContext();
    mockApi.getCommitteeSubResource.mockResolvedValueOnce({
      data: [{ number: 'first' }],
      pagination: { count: 10, nextOffset: 1 },
    });
    const input = committeeLookupTool.input.parse({
      operation: 'bills',
      chamber: 'house',
      committeeCode: 'hsju00',
      offset: 10,
    });
    const result = await committeeLookupTool.handler(input, ctx);

    expect(mockApi.getCommitteeSubResource).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ count: 10, nextOffset: null });
  });
});
