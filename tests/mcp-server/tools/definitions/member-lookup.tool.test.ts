/**
 * @fileoverview Tests for congressgov_member_lookup tool.
 * @module tests/mcp-server/tools/definitions/member-lookup.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import { memberLookupTool } from '@/mcp-server/tools/definitions/member-lookup.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

describe('memberLookupTool', () => {
  const mockApi = {
    listMembers: vi.fn(),
    getMember: vi.fn(),
    getMemberLegislation: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists members', async () => {
    const ctx = createMockContext();
    mockApi.listMembers.mockResolvedValue({
      data: [{ name: 'Smith' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({ operation: 'list' });
    const result = await memberLookupTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('lists members filtered by state', async () => {
    const ctx = createMockContext();
    mockApi.listMembers.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({
      operation: 'list',
      stateCode: 'CA',
    });
    await memberLookupTool.handler(input, ctx);
    expect(mockApi.listMembers).toHaveBeenCalledWith(expect.objectContaining({ stateCode: 'CA' }));
  });

  it('throws when district is provided without stateCode', async () => {
    const ctx = createMockContext();
    const input = memberLookupTool.input.parse({ operation: 'list', district: 5 });
    await expect(memberLookupTool.handler(input, ctx)).rejects.toThrow(/stateCode/);
  });

  it('gets a member by bioguideId', async () => {
    const ctx = createMockContext();
    mockApi.getMember.mockResolvedValue({ member: { name: 'Pelosi' } });
    const input = memberLookupTool.input.parse({
      operation: 'get',
      bioguideId: 'P000197',
    });
    const result = await memberLookupTool.handler(input, ctx);
    expect(result.member).toEqual({ name: 'Pelosi' });
  });

  it('throws when get/sponsored/cosponsored is missing bioguideId', async () => {
    const ctx = createMockContext();
    const input = memberLookupTool.input.parse({ operation: 'get' });
    await expect(memberLookupTool.handler(input, ctx)).rejects.toThrow(/bioguideId/);
  });

  it('fetches sponsored legislation', async () => {
    const ctx = createMockContext();
    mockApi.getMemberLegislation.mockResolvedValue({
      legislation: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({
      operation: 'sponsored',
      bioguideId: 'P000197',
    });
    await memberLookupTool.handler(input, ctx);
    expect(mockApi.getMemberLegislation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sponsored-legislation' }),
    );
  });

  it('fetches cosponsored legislation', async () => {
    const ctx = createMockContext();
    mockApi.getMemberLegislation.mockResolvedValue({
      legislation: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = memberLookupTool.input.parse({
      operation: 'cosponsored',
      bioguideId: 'P000197',
    });
    await memberLookupTool.handler(input, ctx);
    expect(mockApi.getMemberLegislation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cosponsored-legislation' }),
    );
  });
});
