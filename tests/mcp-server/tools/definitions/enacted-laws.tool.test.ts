/**
 * @fileoverview Tests for congressgov_enacted_laws tool.
 * @module tests/mcp-server/tools/definitions/enacted-laws.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { enactedLawsTool } from '@/mcp-server/tools/definitions/enacted-laws.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('enactedLawsTool', () => {
  const mockApi = {
    listLaws: vi.fn(),
    getLaw: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists laws by congress', async () => {
    const ctx = createMockContext();
    mockApi.listLaws.mockResolvedValue({
      data: [{ lawNumber: 1 }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = enactedLawsTool.input.parse({ operation: 'list', congress: 118 });
    const result = await enactedLawsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
    expect(mockApi.listLaws).toHaveBeenCalledWith(expect.objectContaining({ congress: 118 }), ctx);
  });

  it('lists laws filtered by type', async () => {
    const ctx = createMockContext();
    mockApi.listLaws.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = enactedLawsTool.input.parse({
      operation: 'list',
      congress: 118,
      lawType: 'pub',
    });
    await enactedLawsTool.handler(input, ctx);
    expect(mockApi.listLaws).toHaveBeenCalledWith(expect.objectContaining({ lawType: 'pub' }), ctx);
  });

  it('gets a specific law', async () => {
    const ctx = createMockContext();
    mockApi.getLaw.mockResolvedValue({ law: { title: 'Public Law 118-1' } });
    const input = enactedLawsTool.input.parse({
      operation: 'get',
      congress: 118,
      lawType: 'pub',
      lawNumber: 1,
    });
    const result = await enactedLawsTool.handler(input, ctx);
    expect(result.law).toEqual({ title: 'Public Law 118-1' });
    expect(mockApi.getLaw).toHaveBeenCalledWith(
      expect.objectContaining({ congress: 118, lawType: 'pub', lawNumber: 1 }),
      ctx,
    );
  });

  it('throws when get is missing lawType or lawNumber', async () => {
    const ctx = createMockContext();
    const input = enactedLawsTool.input.parse({ operation: 'get', congress: 118 });
    await expect(enactedLawsTool.handler(input, ctx)).rejects.toThrow(/requires/);
  });
});
