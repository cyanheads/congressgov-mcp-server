/**
 * @fileoverview Tests for congressgov_senate_nominations tool.
 * @module tests/mcp-server/tools/definitions/senate-nominations.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { senateNominationsTool } from '@/mcp-server/tools/definitions/senate-nominations.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('senateNominationsTool', () => {
  const mockApi = {
    listNominations: vi.fn(),
    getNomination: vi.fn(),
    getNominee: vi.fn(),
    getNominationSubResource: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists nominations by congress', async () => {
    const ctx = createMockContext();
    mockApi.listNominations.mockResolvedValue({
      data: [{ nominationNumber: '1064' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = senateNominationsTool.input.parse({ operation: 'list', congress: 118 });
    const result = await senateNominationsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('gets a specific nomination', async () => {
    const ctx = createMockContext();
    mockApi.getNomination.mockResolvedValue({ nomination: { description: 'Judge' } });
    const input = senateNominationsTool.input.parse({
      operation: 'get',
      congress: 118,
      nominationNumber: '1064',
    });
    const result = await senateNominationsTool.handler(input, ctx);
    expect(result.nomination).toEqual({ description: 'Judge' });
  });

  it('throws when detail operation is missing nominationNumber', async () => {
    const ctx = createMockContext();
    const input = senateNominationsTool.input.parse({ operation: 'get', congress: 118 });
    await expect(senateNominationsTool.handler(input, ctx)).rejects.toThrow(/nominationNumber/);
  });

  it('gets nominees with ordinal', async () => {
    const ctx = createMockContext();
    mockApi.getNominee.mockResolvedValue({
      data: [{ name: 'Doe' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = senateNominationsTool.input.parse({
      operation: 'nominees',
      congress: 118,
      nominationNumber: '1064',
      ordinal: 1,
    });
    const result = await senateNominationsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('throws when nominees is missing ordinal', async () => {
    const ctx = createMockContext();
    const input = senateNominationsTool.input.parse({
      operation: 'nominees',
      congress: 118,
      nominationNumber: '1064',
    });
    await expect(senateNominationsTool.handler(input, ctx)).rejects.toThrow(/ordinal/);
  });

  it('fetches nomination sub-resources (actions, committees, hearings)', async () => {
    const ctx = createMockContext();
    mockApi.getNominationSubResource.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = senateNominationsTool.input.parse({
      operation: 'actions',
      congress: 118,
      nominationNumber: '1064',
    });
    await senateNominationsTool.handler(input, ctx);
    expect(mockApi.getNominationSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'actions' }),
    );
  });
});
